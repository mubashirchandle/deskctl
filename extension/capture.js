import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {DeskctlError, findWindow, workspaceNumber} from './util.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot_stage_to_content');
Gio._promisify(Shell.Screenshot.prototype, 'pick_color');
Gio._promisify(Shell.Screenshot, 'composite_to_stream');

const TREE_MAX_NODES = 5000;
// Structural pseudo classes add noise without telling agents anything.
const QUIET_PSEUDO_CLASSES = new Set(['first-child', 'last-child', 'insensitive']);

function stageRect() {
    return {x: 0, y: 0, width: global.stage.width, height: global.stage.height};
}

function checkRect(rect, bounds) {
    const {x, y, width, height} = rect;
    if (![x, y, width, height].every(Number.isInteger) || width <= 0 || height <= 0)
        throw new DeskctlError('InvalidArgs', 'Area must be integer x, y and positive width, height');
    if (x < bounds.x || y < bounds.y ||
        x + width > bounds.x + bounds.width || y + height > bounds.y + bounds.height) {
        throw new DeskctlError('InvalidArgs',
            `Area ${width}x${height}+${x}+${y} is outside the stage ` +
            `${bounds.width}x${bounds.height}+${bounds.x}+${bounds.y}`);
    }
}

async function writePng(texture, geometry, scale, cursor, fd) {
    // The stream owns the caller's descriptor, so the extension never opens paths.
    const stream = new GioUnix.OutputStream({fd, close_fd: true});
    try {
        const pixbuf = await Shell.Screenshot.composite_to_stream(
            texture, ...geometry, scale,
            cursor?.texture ?? null, cursor?.x ?? 0, cursor?.y ?? 0, cursor?.scale ?? 1,
            stream);
        return {width: pixbuf.get_width(), height: pixbuf.get_height()};
    } finally {
        stream.close(null);
    }
}

async function captureStage(rect, includeCursor, fd) {
    const shooter = new Shell.Screenshot();
    const [content, scale, cursorContent, cursorPoint, cursorScale] =
        await shooter.screenshot_stage_to_content();
    const texture = content.get_texture();
    let cursor = null;
    if (includeCursor && cursorContent) {
        cursor = {
            texture: cursorContent.get_texture(),
            x: cursorPoint.x * scale,
            y: cursorPoint.y * scale,
            scale: cursorScale,
        };
    }
    const geometry = [rect.x * scale, rect.y * scale, rect.width * scale, rect.height * scale]
        .map(Math.round);
    const image = await writePng(texture, geometry, scale, cursor, fd);
    return {logical: rect, image, scale: image.width / rect.width};
}

async function captureWindow(id, fd) {
    const window = findWindow(id);
    const active = global.workspace_manager.get_active_workspace();
    if (window.minimized)
        throw new DeskctlError('Failed', `Window ${id} is minimized; unminimize it first`);
    if (!window.is_on_all_workspaces() && window.get_workspace() !== active) {
        throw new DeskctlError('Failed',
            `Window ${id} is on workspace ${workspaceNumber(window.get_workspace())}; ` +
            'switch there first (deskctl screenshot --workspace N)');
    }
    const actor = window.get_compositor_private();
    const content = actor?.paint_to_content(null);
    const texture = content?.get_texture();
    if (!texture)
        throw new DeskctlError('Failed', `Window ${id} has no content to capture`);

    // The texture covers the buffer rect (client shadows included); crop to
    // the frame rect using the texture's real pixel density.
    const frame = window.get_frame_rect();
    const buffer = window.get_buffer_rect();
    const density = texture.get_width() / buffer.width;
    const geometry = [
        (frame.x - buffer.x) * density, (frame.y - buffer.y) * density,
        frame.width * density, frame.height * density,
    ].map(Math.round);
    const image = await writePng(texture, geometry, density, null, fd);
    return {
        logical: {x: frame.x, y: frame.y, width: frame.width, height: frame.height},
        image,
        scale: image.width / frame.width,
        window: id,
    };
}

export async function screenshot(options, fd) {
    const target = options.target ?? 'screen';
    let result;
    if (target === 'screen') {
        result = await captureStage(stageRect(), options.cursor, fd);
    } else if (target === 'monitor') {
        const monitor = Main.layoutManager.monitors[options.monitor ?? -1];
        if (!monitor)
            throw new DeskctlError('InvalidArgs', `No monitor ${options.monitor}`);
        const {x, y, width, height} = monitor;
        result = await captureStage({x, y, width, height}, options.cursor, fd);
        result.monitor = options.monitor;
    } else if (target === 'area') {
        const rect = {x: options.x, y: options.y, width: options.width, height: options.height};
        checkRect(rect, stageRect());
        result = await captureStage(rect, options.cursor, fd);
    } else if (target === 'window') {
        result = await captureWindow(options.window, fd);
    } else {
        throw new DeskctlError('InvalidArgs', `Unknown screenshot target ${target}`);
    }
    return {target, ...result};
}

export async function pickColor(x, y) {
    checkRect({x, y, width: 1, height: 1}, stageRect());
    const [color] = await new Shell.Screenshot().pick_color(x, y);
    const hex = [color.red, color.green, color.blue]
        .map(c => c.toString(16).padStart(2, '0')).join('');
    return {x, y, color: `#${hex}`, alpha: color.alpha};
}

function treeRoot(name) {
    const statusArea = Main.panel.statusArea;
    const roots = {
        'stage': () => global.stage,
        'ui': () => Main.layoutManager.uiGroup,
        'panel': () => Main.panel,
        'quick-settings': () => statusArea.quickSettings?.menu?.actor,
        'calendar': () => statusArea.dateMenu?.menu?.actor,
        'overview': () => Main.layoutManager.overviewGroup,
        'dash': () => Main.overview.dash,
        'message-tray': () => Main.messageTray,
    };
    const actor = roots[name]?.();
    if (!actor) {
        throw new DeskctlError('InvalidArgs',
            `Unknown tree root ${name}; use one of ${Object.keys(roots).join(', ')}`);
    }
    return actor;
}

function actorText(actor) {
    if (actor instanceof St.Label || actor instanceof St.Entry)
        return actor.get_text();
    if (actor instanceof Clutter.Text)
        return actor.get_text();
    if (actor instanceof St.Button && actor.label)
        return actor.label;
    return null;
}

function iconName(icon) {
    if (icon.icon_name)
        return icon.icon_name;
    if (icon.gicon instanceof Gio.ThemedIcon)
        return icon.gicon.get_names()[0];
    return icon.gicon?.to_string() ?? null;
}

function describe(actor) {
    const node = {type: actor.constructor.$gtype?.name ?? actor.constructor.name};
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    if ([x, y, width, height].every(Number.isFinite))
        node.rect = [x, y, width, height].map(Math.round);
    if (actor.name)
        node.name = actor.name;
    if (actor instanceof St.Widget) {
        const styleClass = actor.get_style_class_name();
        const pseudoClass = (actor.get_style_pseudo_class() ?? '').split(/\s+/)
            .filter(name => name && !QUIET_PSEUDO_CLASSES.has(name)).join(' ');
        if (styleClass)
            node.style_class = styleClass;
        if (pseudoClass)
            node.pseudo_class = pseudoClass;
        const accessibleName = actor.get_accessible_name?.();
        if (accessibleName)
            node.accessible_name = accessibleName;
    }
    if (actor instanceof St.Icon) {
        const icon = iconName(actor);
        if (icon)
            node.icon = icon;
    }
    const text = actorText(actor);
    if (text)
        node.text = text;
    if (!actor.visible)
        node.visible = false;
    else if (!actor.mapped)
        node.mapped = false;
    if (actor.reactive)
        node.reactive = true;
    return node;
}

export function shellTree(rootName, maxDepth, includeHidden) {
    let count = 0;
    let truncated = false;
    const visit = (actor, depth) => {
        count++;
        const node = describe(actor);
        if (!actor.visible && !includeHidden)
            return node;
        const children = actor.get_children();
        if (children.length === 0)
            return node;
        if (depth >= maxDepth) {
            node.children_omitted = children.length;
            return node;
        }
        node.children = [];
        for (const [index, child] of children.entries()) {
            if (count >= TREE_MAX_NODES) {
                truncated = true;
                node.children_omitted = children.length - index;
                break;
            }
            node.children.push(visit(child, depth + 1));
        }
        return node;
    };
    return {root: rootName, truncated, tree: visit(treeRoot(rootName), 0)};
}
