/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';
import Shell from 'gi://Shell';
import Gio from 'gi://Gio';
import Mtk from 'gi://Mtk';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

// Window edge action flags
const WindowEdgeAction = {
    NONE: 0,
    MOVE: 0x02,
    RESIZE: 0x04,

    GESTURE_LEFT: 0x10,
    GESTURE_RIGHT: 0x20,
    GESTURE_UP: 0x40,
    GESTURE_DOWN: 0x80,

    RESIZE_LEFT: 0x1000,
    RESIZE_RIGHT: 0x2000,
    RESIZE_TOP: 0x4000,
    RESIZE_BOTTOM: 0x8000,

    MOVE_SNAP_TOP: 0x10000,
    MOVE_SNAP_LEFT: 0x20000,
    MOVE_SNAP_RIGHT: 0x40000
};

// Window Blacklist Classes
const WindowClassBlacklist = [
    "gjs"
];

// Manager Class
class Manager {

    constructor(ext) {
        this._settings = ext.getSettings();
        this._hooked = false;

        // Create virtual devices
        const seat = Clutter.get_default_backend().get_default_seat();
        this._virtualTouchpad = seat.create_virtual_device(
            Clutter.InputDeviceType.POINTER_DEVICE
        );
        this._virtualKeyboard = seat.create_virtual_device(
            Clutter.InputDeviceType.KEYBOARD_DEVICE
        );

        this._clearVars();

        // Capture Touchpad Event
        this._gestureCallbackID = global.stage.connect(
            'captured-event::touchpad',
            this._touchpadEvent.bind(this)
        );

        this._initFingerCountFlip();
        this._actionWidgets = {};

        // Desktop Theme Setting
        this._isettings = new Gio.Settings({
            schema: 'org.gnome.desktop.interface'
        });
    }

    destroyTimers() {
        if (this._holdTo) {
            clearTimeout(this._holdTo);
            this._holdTo = null;
        }
        if (this._actionWidgets.resetWinlist) {
            clearTimeout(this._actionWidgets.resetWinlist);
            this._actionWidgets.resetWinlist = null;
        }
        if (this._keyRepeatInterval) {
            clearInterval(this._keyRepeatInterval);
            this._keyRepeatInterval = null;
        }
        if (this._flingInterval) {
            clearInterval(this._flingInterval);
            this._flingInterval = null;
        }
        if (this._actionWidgets.tilerHider) {
            clearTimeout(this._actionWidgets.tilerHider);
            this._actionWidgets.tilerHider = null;
        }
        if (this._actionWidgets.resetApplist) {
            clearTimeout(this._actionWidgets.resetApplist);
            this._actionWidgets.resetApplist = null;
        }
    }

    destroy() {
        this.destroyTimers();
        this._restoreFingerCountFlip();
        global.stage.disconnect(this._gestureCallbackID);

        this._virtualTouchpad = null;
        this._virtualKeyboard = null;

        this._clearVars();
        this._isettings = null;
        this._settings = null;
    }

    _clearVars() {
        this._targetWindow = null;
        this._startPos = { x: 0, y: 0 };
        this._movePos = { x: 0, y: 0 };
        this._monitorId = 0;
        this._monitorArea = null;
        this._startWinArea = null;

        this._edgeAction = WindowEdgeAction.NONE;
        this._edgeGestured = 0;
        this._swipeIsWin = false;
        this._isActiveWin = false;
        this._tapHold = 0;
        this._tapHoldWin = null;
        this._tapHoldTick = 0;

        this._gesture = {
            begin: false,
            fingers: 0,
            progress: 0,
            velocity: null,
            action: 0,
            action_id: 0,
            action_cmp: 0
        };
    }

    // Init 3 or 4 finger count switch mode
    _initFingerCountFlip() {
        /*
         * Original Hook Logic From (swap-finger-gestures):
         * https://github.com/icedman/swap-finger-gestures-3-4
         */
        this._swipeMods = [
            Main.overview._swipeTracker._touchpadGesture,
            Main.wm._workspaceAnimation._swipeTracker._touchpadGesture,
            Main.overview._overview._controls
                ._workspacesDisplay._swipeTracker._touchpadGesture,
            Main.overview._overview._controls
                ._appDisplay._swipeTracker._touchpadGesture
        ];
        let me = this;
        this._swipeMods.forEach((g) => {
            g._newHandleEvent = (actor, event) => {
                event._get_touchpad_gesture_finger_count =
                    event.get_touchpad_gesture_finger_count;
                event.get_touchpad_gesture_finger_count = () => {
                    let real_count = event._get_touchpad_gesture_finger_count();
                    if (me._hooked || (real_count == me._gestureNumFinger())) {
                        return 0;
                    }
                    else if (real_count >= 3) {
                        return 3;
                    }
                    return 0;
                };
                if (me._hooked) {
                    return Clutter.EVENT_STOP;
                }
                return g._handleEvent(actor, event);
            };
            global.stage.disconnectObject(g);
            global.stage.connectObject(
                'captured-event::touchpad',
                g._newHandleEvent.bind(g),
                g
            );
        });
    }

    _restoreFingerCountFlip() {
        this._swipeMods.forEach((g) => {
            global.stage.disconnectObject(g);
            global.stage.connectObject(
                'captured-event::touchpad',
                g._handleEvent.bind(g),
                g
            );
        });
        this._swipeMods = [];
    }

    _isDarkTheme() {
        let uit = this._settings.get_int('ui-theme');
        if (uit == 0) {
            return (this._isettings
                .get_string('color-scheme') == 'prefer-dark');
        }
        return (uit == 2);
    }

    _createUi(ui_class, x, y, w, h, icon) {
        let ui = new St.Widget({ style_class: ui_class });
        if (this._isDarkTheme()) {
            ui.add_style_class_name("wgs-dark");
        }
        ui._icon = null;
        ui._parent = Main.layoutManager.uiGroup;
        if (icon) {
            ui._icon = new St.Icon({
                icon_name: icon,
                style_class: 'wgs-widget-icon'
            });
            ui.add_child(ui._icon);
        }
        ui.set_position(x, y);
        ui.set_size(w, h);
        ui.set_pivot_point(0.5, 0.5);
        ui.viewShow = (prop, duration) => {
            ui.show();
            prop.mode = Clutter.AnimationMode.EASE_OUT_QUAD;
            prop.duration = duration;
            ui.ease(prop);
        };
        ui.aniRelease = (progress) => {
            if (!progress) {
                progress = 1.0;
            }
            if (progress > 0.2) {
                ui.ease({
                    opacity: 0,
                    scale_x: 0,
                    scale_y: 0,
                    duration: Math.round(250 * progress),
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => {
                        ui.release();
                    }
                });
            }
            else {
                ui.release();
            }
        };
        ui.release = () => {
            ui.hide();
            ui._parent.remove_child(ui);
            if (ui._icon) {
                ui.remove_child(ui._icon);
                ui._icon.destroy();
                ui._icon = null;
            }
            ui.destroy();
            ui = null;
        };
        ui._parent.add_child(ui);
        return ui;
    }

    _createShader(type, actor, name) {
        let fx = new Clutter.ShaderEffect(
            { shader_type: Clutter.ShaderType.FRAGMENT_SHADER }
        );
        let shader = '';
        if (type == 'close') {
            shader =
                'color.g *= 1-(0.3*value); ' +
                'color.b *= 1-(0.34*value); ';
        }
        else {
            shader =
                'color.rgb *= 1.0-value; ';
        }
        fx.set_shader_source(
            'uniform sampler2D tex; ' +
            'uniform float value; ' +
            'void main() { ' +
            'vec4 color=texture2D(tex,cogl_tex_coord_in[0].st);' +
            shader +
            'cogl_color_out = color * cogl_color_in;}'
        );
        fx.set_uniform_value('tex', 0);
        fx.setValue = function (v) {
            fx.set_uniform_value('value', v);
        };
        if (actor) {
            fx._fxname = name;
            actor.fx = fx;
            if (actor.get_effect(name)) {
                actor.remove_effect_by_name(name);
            }
            actor.add_effect_with_name(name, fx);
        }
        fx.release = () => {
            if (actor) {
                actor.remove_effect_by_name(actor.fx._fxname);
                actor.fx = null;
                actor = null;
            }
            fx = null;
        };
        return fx;
    }

    // Velocity functions
    _velocityInit() {
        return { data: [], prev: 0 };
    }
    _velocityTrim(vel) {
        const thresholdTime = this._tick() - 150;
        const index = vel.data.findIndex(r => r.time >= thresholdTime);
        vel.data.splice(0, index);
    }
    _velocityAppend(vel, v) {
        this._velocityTrim(vel);
        let vb = Math.abs(v);
        let d = vb - vel.prev;
        vel.prev = vb;
        vel.data.push({ time: this._tick(), delta: d });
    }
    _velocityCalc(vel) {
        this._velocityTrim(vel);
        if (vel.data.length < 2)
            return 0;
        const firstTime = vel.data[0].time;
        const lastTime = vel.data[vel.data.length - 1].time;
        if (firstTime === lastTime)
            return 0;
        const totalDelta = vel.data.slice(1).map(
            a => a.delta).reduce((a, b) => a + b);
        const period = lastTime - firstTime;
        return totalDelta / period;
    }
    _velocityFlingHandler(me) {
        if (me._velocityFlingQueue.length == 0) {
            clearInterval(me._flingInterval);
            me._flingInterval = 0;
            return;
        }
        let now = me._velocityFlingQueue[0];
        let clearIt = false;
        now.target += now.v * 2;
        now.v *= 0.98;
        now.n++;
        if (me._velocityFlingQueue.length != 1) {
            now.cb(1, now.target);
            clearIt = true;
        }
        else if (now.target >= now.max || now.n >= now.maxframe) {
            if (now.target >= now.max) {
                now.target = now.max;
            }
            now.cb(1, now.target);
            clearIt = true;
        }
        else {
            now.cb(0, now.target);
        }
        if (clearIt) {
            me._velocityFlingQueue.splice(0, 1);
        }
    }
    _velocityFling(vel, curr, max, maxframe, cb) {
        if (!this._velocityFlingQueue) {
            this._velocityFlingQueue = [];
        }
        this._velocityFlingQueue.push({
            target: curr,
            v: vel,
            max: max,
            maxframe: maxframe,
            cb: cb,
            n: 0
        });
        if (!this._flingInterval) {
            this._flingInterval = setInterval(
                this._velocityFlingHandler, 4, this
            );
        }
    }
    _tick() {
        return new Date().getTime();
    }

    _isWindowBlacklist(win) {
        if (win) {
            if (WindowClassBlacklist.indexOf(win.get_wm_class()) == -1 ||
                win.get_window_type() === Meta.WindowType.DESKTOP) {
                return false;
            }
        }
        return true;
    }

    // Settings accessors
    _edgeSize() {
        return this._settings.get_int('edge-size');
    }
    _topEdgeSize() {
        return this._settings.get_int('top-edge-size');
    }
    _gestureThreshold() {
        return this._settings.get_int('gesture-threshold');
    }
    _getAcceleration() {
        return (this._settings.get_int('gesture-acceleration') * 0.1);
    }
    _gestureNumFinger() {
        return this._settings.get_boolean("three-finger") ? 3 : 4;
    }
    _getUseActiveWindow() {
        return this._settings.get_boolean("use-active-window");
    }
    _getEnableResize() {
        return this._settings.get_boolean("fn-resize");
    }
    _getEnableMove() {
        return this._settings.get_boolean("fn-move");
    }
    _getEnableMoveSnap() {
        return this._settings.get_boolean("fn-move-snap");
    }
    _getEnableFullscreen() {
        return this._settings.get_boolean("fn-fullscreen");
    }
    _getPinchInScale() {
        return this._settings.get_int('pinch-in-scale');
    }
    _getPinchOutScale() {
        return this._settings.get_int('pinch-out-scale');
    }
    _getPinchEnabled() {
        return this._settings.get_boolean("pinch-enable");
    }
    _getTapHoldMove() {
        return this._settings.get_boolean("taphold-move");
    }

    _isOnOverview() {
        return Main.overview._shown;
    }

    _isEdge(edge) {
        return ((this._edgeAction & edge) == edge);
    }

    _showPreview(rx, ry, rw, rh) {
        if (global.display.get_focus_window() == null) {
            return;
        }
        global.window_manager.emit("show-tile-preview",
            global.display.get_focus_window(), new Mtk.Rectangle(
                { x: rx, y: ry, width: rw, height: rh }
            )
            , this._monitorId
        );
    }

    _hidePreview() {
        global.window_manager.emit("hide-tile-preview");
    }

    _findPointerWindow() {
        let target = null;
        let [pointerX, pointerY] = global.get_pointer();
        let currActor = global.stage.get_actor_at_pos(
            Clutter.PickMode.REACTIVE, pointerX, pointerY
        );
        if (currActor) {
            let currWindow = currActor.get_parent();
            let i = 0;
            while (currWindow && !currWindow.get_meta_window) {
                currWindow = currWindow.get_parent();
                if (!currWindow || (++i > 10)) {
                    currWindow = null;
                    break;
                }
            }
            target = currWindow?.get_meta_window();
        }
        return target;
    }

    // Get window tab list, optionally sorted by process creation time
    _getWindowTabList(fixedOrder) {
        let workspace = global.workspace_manager.get_active_workspace();
        let windows = global.display.get_tab_list(
            Meta.TabList.NORMAL_ALL, workspace
        );
        let filtered = windows.map(w => {
            return w.is_attached_dialog() ? w.get_transient_for() : w;
        }).filter((w, i, a) => !w.skip_taskbar && a.indexOf(w) === i);

        if (fixedOrder) {
            filtered.sort((a, b) => {
                return this._getProcessCreationTime(a.get_pid())
                    - this._getProcessCreationTime(b.get_pid());
            });
        }
        return filtered;
    }

    // Get application list, optionally sorted by process creation time
    _getApplicationList(fixedOrder) {
        let workspace = global.workspace_manager.get_active_workspace();
        let windows = global.display.get_tab_list(
            Meta.TabList.NORMAL_ALL, workspace
        );

        let appMap = new Map();
        windows.forEach(w => {
            let window = w.is_attached_dialog() ? w.get_transient_for() : w;
            if (!window || window.skip_taskbar) return;

            let app = this._winmanWinApp(window);
            if (!app) return;

            if (!appMap.has(app)) {
                appMap.set(app, []);
            }
            appMap.get(app).push(window);
        });

        let apps = Array.from(appMap.entries()).map(([app, wins]) => ({
            app, windows: wins, activeWindow: wins[0]
        }));

        if (fixedOrder) {
            apps.forEach(a => {
                a.processTime = this._getProcessCreationTime(
                    a.activeWindow.get_pid()
                );
            });
            apps.sort((a, b) => a.processTime - b.processTime);
        } else {
            let activeWindow = global.display.get_focus_window();
            if (activeWindow) {
                let activeApp = this._winmanWinApp(activeWindow);
                if (activeApp) {
                    let idx = apps.findIndex(a => a.app === activeApp);
                    if (idx > 0) {
                        apps.unshift(apps.splice(idx, 1)[0]);
                    }
                }
            }
        }

        return apps;
    }

    _sendKeyPress(combination) {
        combination.forEach(key => this._virtualKeyboard.notify_keyval(
            Clutter.get_current_event_time(), key, Clutter.KeyState.PRESSED)
        );
        combination.reverse().forEach(key =>
            this._virtualKeyboard.notify_keyval(
                Clutter.get_current_event_time(), key, Clutter.KeyState.RELEASED
            ));
    }

    _movePointer(x, y) {
        if (!this._isActiveWin) {
            this._virtualTouchpad.notify_relative_motion(
                Meta.CURRENT_TIME, x, y
            );
        }
    }

    _winmanWinApp(win) {
        return Shell.WindowTracker.get_default()
            .get_window_app(win);
    }

    _setSnapWindow(snapRight) {
        if (this._targetWindow == null) {
            return;
        }
        if (snapRight) {
            this._sendKeyPress([Clutter.KEY_Super_L, Clutter.KEY_Right]);
        }
        else {
            this._sendKeyPress([Clutter.KEY_Super_L, Clutter.KEY_Left]);
        }
    }

    _insertWorkspace(pos, chkwin) {
        let wm = global.workspace_manager;
        if (!Meta.prefs_get_dynamic_workspaces()) {
            return -1;
        }
        wm.append_new_workspace(false, Meta.CURRENT_TIME);
        let windows = global.get_window_actors().map(a => a.meta_window);
        windows.forEach(window => {
            if (chkwin && chkwin == window)
                return;
            if (window.get_transient_for() != null)
                return;
            if (window.is_override_redirect())
                return;
            if (window.on_all_workspaces)
                return;
            let index = window.get_workspace().index();
            if (index < pos)
                return;
            window.change_workspace_by_index(index + 1, true);
        });
        if (chkwin) {
            wm.get_workspace_by_index(pos + 1).activate(
                Meta.CURRENT_TIME
            );
            chkwin.change_workspace_by_index(pos, true);
            this._targetWindow.activate(Meta.CURRENT_TIME);
        }
        return pos;
    }

    _isDynamicWorkspace() {
        return Meta.prefs_get_dynamic_workspaces();
    }

    _resetWinPos() {
        if (this._targetWindow == null) {
            return;
        }
        this._targetWindow.move_frame(
            true,
            this._startWinArea.x,
            this._startWinArea.y
        );
    }

    _activateWindow() {
        if (this._targetWindow == null) {
            return;
        }
        if (!this._targetWindow.has_focus()) {
            this._targetWindow.activate(
                Meta.CURRENT_TIME
            );
        }
    }

    _swipeUpdateMove() {
        this._activateWindow();

        // gnome-shell-extension-tiling-assistant support
        if (this._targetWindow.isTiled) {
            let urct = this._targetWindow.untiledRect;
            if (urct) {
                let r = urct._rect;
                this._startWinArea.x = r.x;
                this._startWinArea.y = r.y;
                this._startWinArea.width = r.width;
                this._startWinArea.height = r.height;
                this._sendKeyPress([Clutter.KEY_Super_L, Clutter.KEY_Down]);
            }
        }

        let allowMoveSnap = this._getEnableMoveSnap();
        let mX = this._monitorArea.x;
        let mY = this._monitorArea.y;
        let mW = this._monitorArea.width;
        let mR = mX + mW;
        let winX = this._startWinArea.x + this._movePos.x;
        let winY = this._startWinArea.y + this._movePos.y;
        let winR = winX + this._startWinArea.width;

        this._targetWindow.move_frame(
            true,
            winX, winY
        );
        if (allowMoveSnap && winX < mX) {
            this._showPreview(
                this._monitorArea.x,
                this._monitorArea.y,
                this._monitorArea.width / 2,
                this._monitorArea.height
            );
            this._edgeAction = WindowEdgeAction.MOVE
                | WindowEdgeAction.MOVE_SNAP_LEFT;
        }
        else if (allowMoveSnap && winR > mR) {
            this._showPreview(
                this._monitorArea.x + (this._monitorArea.width / 2),
                this._monitorArea.y,
                this._monitorArea.width / 2,
                this._monitorArea.height
            );
            this._edgeAction = WindowEdgeAction.MOVE
                | WindowEdgeAction.MOVE_SNAP_RIGHT;
        }
        else if (allowMoveSnap && winY < mY) {
            this._showPreview(
                this._monitorArea.x,
                this._monitorArea.y,
                this._monitorArea.width,
                this._monitorArea.height
            );
            this._edgeAction = WindowEdgeAction.MOVE
                | WindowEdgeAction.MOVE_SNAP_TOP;
        }
        else {
            this._edgeAction = WindowEdgeAction.MOVE;
            this._hidePreview();
        }
        return Clutter.EVENT_STOP;
    }

    _swipeUpdateResize(dx, dy) {
        this._activateWindow();
        this._movePointer(
            (this._isEdge(WindowEdgeAction.RESIZE_LEFT) ||
                this._isEdge(WindowEdgeAction.RESIZE_RIGHT)) ? dx : 0,
            (this._isEdge(WindowEdgeAction.RESIZE_TOP) ||
                this._isEdge(WindowEdgeAction.RESIZE_BOTTOM)) ? dy : 0
        );
        let tX = this._startWinArea.x;
        let tY = this._startWinArea.y;
        let tW = this._startWinArea.width;
        let tH = this._startWinArea.height;
        if (this._isEdge(WindowEdgeAction.RESIZE_BOTTOM)) {
            tH += this._movePos.y;
        }
        else if (this._isEdge(WindowEdgeAction.RESIZE_TOP)) {
            tY += this._movePos.y;
            tH -= this._movePos.y;
        }
        if (this._isEdge(WindowEdgeAction.RESIZE_RIGHT)) {
            tW += this._movePos.x;
        }
        else if (this._isEdge(WindowEdgeAction.RESIZE_LEFT)) {
            tX += this._movePos.x;
            tW -= this._movePos.x;
        }
        let tR = tX + tW;
        let tB = tY + tH;
        let mX = this._monitorArea.x;
        let mY = this._monitorArea.y;
        let mR = mX + this._monitorArea.width;
        let mB = mY + this._monitorArea.height;
        if (tX < mX) {
            tX = mX;
            tW = tR - tX;
        }
        if (tY < mY) {
            tY = mY;
            tH = tB - tY;
        }
        if (tR > mR) {
            tW = mR - tX;
        }
        if (tB > mB) {
            tH = mB - tY;
        }
        this._targetWindow.move_resize_frame(
            true,
            tX, tY, tW, tH
        );
        return Clutter.EVENT_STOP;
    }

    _swipeBegin(numfingers) {
        this._swipeIsWin = (numfingers == this._gestureNumFinger());

        if (this._isOnOverview() && !this._swipeIsWin) {
            return Clutter.EVENT_PROPAGATE;
        }

        this._gesture.begin = true;
        this._gesture.fingers = numfingers;
        this._gesture.progress = 0;
        this._gesture.action = 0;
        this._gesture.action_cmp = 0;
        this._gesture.action_id = 0;
        this._gesture.velocity = this._velocityInit();
        this._velocityAppend(this._gesture.velocity, 0);

        let [pointerX, pointerY] = global.get_pointer();
        this._startPos.x = pointerX;
        this._startPos.y = pointerY;
        this._movePos.x = this._movePos.y = 0;

        let allowResize = this._getEnableResize();
        let allowMove = this._getEnableMove();
        this._isActiveWin = false;
        this._targetWindow = null;
        let isTapHoldAction = false;

        // Clear unswipe tap-hold
        if ((this._tapHoldTick != 1) &&
            (this._tapHoldTick < this._tick())) {
            this._tapHold = this._tapHoldTick = 0;
            this._tapHoldWin = null;
        }

        if (this._tapHoldWin) {
            this._targetWindow = this._tapHoldWin;
            this._tapHoldWin = null;
            isTapHoldAction = true;
        }
        else if (!this._getUseActiveWindow() && !this._getTapHoldMove()) {
            this._targetWindow = this._findPointerWindow();
        }
        if (!this._targetWindow) {
            this._targetWindow = global.display.get_focus_window();
            if (!this._targetWindow) {
                return this._swipeIsWin ?
                    Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
            }
            allowResize = false;
            this._isActiveWin = true;
        }

        if (this._targetWindow.is_attached_dialog()) {
            this._targetWindow = this._targetWindow.get_transient_for();
        }

        if (this._isWindowBlacklist(this._targetWindow)) {
            this._targetWindow = null;
            return this._swipeIsWin ?
                Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        }

        this._monitorArea = this._targetWindow.get_work_area_current_monitor();
        this._monitorId = global.display.get_monitor_index_for_rect(
            this._monitorArea
        );
        this._startWinArea = this._targetWindow.get_frame_rect();

        let wLeft = this._startWinArea.x;
        let wTop = this._startWinArea.y;
        let wRight = wLeft + this._startWinArea.width;
        let wBottom = wTop + this._startWinArea.height;
        let wThirdX = wLeft + (this._startWinArea.width / 3);
        let wThirdY = wTop + (this._startWinArea.height / 3);
        let w34X = wLeft + ((this._startWinArea.width / 3) * 2);
        let w34Y = wTop + ((this._startWinArea.height / 3) * 2);

        let edge = this._edgeSize();
        let topEdge = this._topEdgeSize();

        this._edgeAction = WindowEdgeAction.NONE;
        this._edgeGestured = 0;

        if (this._swipeIsWin && !this._isActiveWin && allowResize &&
            this._targetWindow.allows_resize() &&
            this._targetWindow.allows_move() &&
            !this._targetWindow.isTiled && !isTapHoldAction) {
            if (this._startPos.y >= wBottom - edge) {
                if (this._startPos.y <= wBottom) {
                    this._edgeAction =
                        WindowEdgeAction.RESIZE |
                        WindowEdgeAction.RESIZE_BOTTOM;
                    if (this._startPos.x <= wThirdX) {
                        this._edgeAction |= WindowEdgeAction.RESIZE_LEFT;
                    }
                    else if (this._startPos.x >= w34X) {
                        this._edgeAction |= WindowEdgeAction.RESIZE_RIGHT;
                    }
                }
            }
            else {
                if (this._startPos.x >= wLeft && this._startPos.x <= wRight) {
                    if (this._startPos.x <= wLeft + edge) {
                        this._edgeAction =
                            WindowEdgeAction.RESIZE |
                            WindowEdgeAction.RESIZE_LEFT;
                    }
                    else if (this._startPos.x >= wRight - edge) {
                        this._edgeAction =
                            WindowEdgeAction.RESIZE |
                            WindowEdgeAction.RESIZE_RIGHT;
                    }
                    if (this._isEdge(WindowEdgeAction.RESIZE)) {
                        if (this._startPos.y <= wThirdY) {
                            this._edgeAction |= WindowEdgeAction.RESIZE_TOP;
                        }
                        else if (this._startPos.y >= w34Y) {
                            this._edgeAction |= WindowEdgeAction.RESIZE_BOTTOM;
                        }
                    }
                }
            }
        }
        if (this._swipeIsWin && !this._isEdge(WindowEdgeAction.RESIZE)) {
            let setmove = false;
            if (this._getTapHoldMove()) {
                if (this._tapHold == this._gestureNumFinger()) {
                    setmove = true;
                }
            }
            else if (allowMove &&
                this._startPos.x <= wRight &&
                this._startPos.x >= wLeft &&
                this._startPos.y >= wTop &&
                this._startPos.y <= wTop + topEdge) {
                setmove = true;
            }
            if (setmove) {
                if (this._targetWindow.allows_move() &&
                    !this._targetWindow.is_maximized()) {
                    this._edgeAction = WindowEdgeAction.MOVE;
                }
            }
        } else if (this._tapHold > 2 &&
            this._tapHold != this._gestureNumFinger()) {
            this._edgeAction = WindowEdgeAction.GESTURE_DOWN;
            this._movePos.y = (this._gestureThreshold() / 4) + 1;
        }

        return this._swipeIsWin ?
            Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }

    _swipeUpdate(dx, dy) {
        if (!this._gesture.begin) {
            return Clutter.EVENT_PROPAGATE;
        }

        this._movePos.x += dx;
        this._movePos.y += dy;

        if (this._isEdge(WindowEdgeAction.MOVE)) {
            return this._swipeUpdateMove();
        }
        else if (this._isEdge(WindowEdgeAction.RESIZE)) {
            return this._swipeUpdateResize(dx, dy);
        }

        let threshold = this._gestureThreshold();
        let combineTrigger = this._gestureThreshold() * 2;
        let trigger = (threshold / 4) + 1;
        let target = 1.00 * (trigger + (threshold * 10));
        let absX = Math.abs(this._movePos.x);
        let absY = Math.abs(this._movePos.y);

        if (this._edgeAction == WindowEdgeAction.NONE) {
            if (absX >= trigger || absY >= trigger) {
                if (absX > absY) {
                    if (this._movePos.x <= 0 - trigger) {
                        this._edgeAction = WindowEdgeAction.GESTURE_LEFT;
                    }
                    else if (this._movePos.x >= trigger) {
                        this._edgeAction = WindowEdgeAction.GESTURE_RIGHT;
                    }
                    this._movePos.y = 0;
                }
                else {
                    if (this._movePos.y <= 0 - trigger) {
                        this._edgeAction = WindowEdgeAction.GESTURE_UP;
                    }
                    else if (this._movePos.y >= trigger) {
                        this._edgeAction = WindowEdgeAction.GESTURE_DOWN;
                        if (this._swipeIsWin) {
                            let allowMove = this._getEnableMove();
                            let holdMove = this._getTapHoldMove();

                            if (!allowMove || holdMove) {
                                if (!this._targetWindow.is_maximized() &&
                                    !this._targetWindow.isTiled) {
                                    this._edgeGestured = 1;
                                }
                                else {
                                    this._edgeGestured = 0;
                                }
                            }
                            else if (
                                !this._edgeGestured &&
                                !this._targetWindow.is_fullscreen() &&
                                !this._targetWindow.is_maximized() &&
                                this._targetWindow.allows_move()) {
                                this._edgeAction = WindowEdgeAction.MOVE;
                                return this._swipeUpdateMove();
                            }
                        }
                    }
                    this._movePos.x = 0;
                }
                this._edgeGestured = this._edgeGestured ? 2 : 1;
                this._gesture.velocity = this._velocityInit();
                this._velocityAppend(this._gesture.velocity, 0);
            }
        }

        let prog = 0;
        let vert = 0;
        let horiz = 0;
        if (this._isEdge(WindowEdgeAction.GESTURE_LEFT)) {
            if (!this._swipeIsWin && !this._hooked) {
                return Clutter.EVENT_PROPAGATE;
            }
            let xmove = this._movePos.x + trigger;
            if (this._isEdge(WindowEdgeAction.GESTURE_UP) ||
                this._isEdge(WindowEdgeAction.GESTURE_DOWN)) {
                xmove = this._movePos.x + combineTrigger;
            }
            else if (!this._swipeIsWin) {
                return Clutter.EVENT_PROPAGATE;
            }
            if (xmove < 0) {
                prog = Math.abs(xmove) / target;
            }
            horiz = 1;
        }
        else if (this._isEdge(WindowEdgeAction.GESTURE_RIGHT)) {
            if (!this._swipeIsWin && !this._hooked) {
                return Clutter.EVENT_PROPAGATE;
            }
            let xmove = this._movePos.x - trigger;
            if (this._isEdge(WindowEdgeAction.GESTURE_UP) ||
                this._isEdge(WindowEdgeAction.GESTURE_DOWN)) {
                xmove = this._movePos.x - combineTrigger;
            }
            else if (!this._swipeIsWin) {
                return Clutter.EVENT_PROPAGATE;
            }
            if (xmove > 0) {
                prog = xmove / target;
            }
            horiz = 2;
        }
        else if (this._isEdge(WindowEdgeAction.GESTURE_UP)) {
            if (!this._swipeIsWin && !this._hooked) {
                return Clutter.EVENT_PROPAGATE;
            }
            if (this._movePos.y < 0) {
                prog = Math.abs(this._movePos.y) / target;
            }
            vert = 1;
        }
        else if (this._isEdge(WindowEdgeAction.GESTURE_DOWN)) {
            if (!this._swipeIsWin && this._isOnOverview()) {
                return Clutter.EVENT_PROPAGATE;
            }
            if (!this._swipeIsWin) {
                this._hooked = true;
            }
            if (this._movePos.y > 0) {
                let movey = this._movePos.y - (this._swipeIsWin ?
                    threshold : (threshold * 6));
                if (movey < 0) {
                    movey = 0;
                }
                prog = movey / target;
            }
            vert = 2;
        }

        if (vert) {
            if (absX >= trigger && ((vert == 1 && this._swipeIsWin) ||
                (vert == 2 && !this._swipeIsWin))) {
                if (vert == 1 || prog == 0) {
                    if (this._movePos.x <= 0 - combineTrigger) {
                        this._edgeAction |= WindowEdgeAction.GESTURE_LEFT;
                        this._gesture.velocity = this._velocityInit();
                        this._velocityAppend(this._gesture.velocity, 0);
                        this._movePos.x = 0 - combineTrigger;
                        return this._swipeUpdate(0, 0);
                    }
                    else if (this._movePos.x >= combineTrigger) {
                        this._edgeAction |= WindowEdgeAction.GESTURE_RIGHT;
                        this._gesture.velocity = this._velocityInit();
                        this._velocityAppend(this._gesture.velocity, 0);
                        this._movePos.x = combineTrigger;
                        return this._swipeUpdate(0, 0);
                    }
                }
            }
        }
        else if (horiz) {
            if (this._isEdge(WindowEdgeAction.GESTURE_UP)) {
                vert = 1;
                if (Math.abs(this._movePos.x) < combineTrigger) {
                    this._edgeAction = WindowEdgeAction.GESTURE_UP;
                    this._gesture.velocity = this._velocityInit();
                    this._velocityAppend(this._gesture.velocity, 0);
                    this._movePos.y = 0 - combineTrigger;
                    return this._swipeUpdate(0, 0);
                }
            }
            else if (this._isEdge(WindowEdgeAction.GESTURE_DOWN)) {
                vert = 2;
                if (Math.abs(this._movePos.x) < combineTrigger) {
                    this._edgeAction = WindowEdgeAction.GESTURE_DOWN;
                    this._gesture.velocity = this._velocityInit();
                    this._velocityAppend(this._gesture.velocity, 0);
                    this._movePos.y = combineTrigger;
                    return this._swipeUpdate(0, 0);
                }
            }
        }

        if (
            (vert == 1 && (this._movePos.y > 0 - trigger)) ||
            (vert == 2 && (this._movePos.y < 0)) ||
            (horiz == 1 && (this._movePos.x > 0 - trigger)) ||
            (horiz == 2 && (this._movePos.x < 0))
        ) {
            if (!(this._isEdge(WindowEdgeAction.GESTURE_DOWN) && horiz)) {
                if (vert) {
                    this._movePos.x = 0;
                }
                if (horiz) {
                    this._movePos.y = 0;
                }
                this._edgeAction = WindowEdgeAction.NONE;
                this._gesture.velocity = this._velocityInit();
                this._velocityAppend(this._gesture.velocity, 0);
                return this._swipeUpdate(0, 0);
            }
        }

        if (prog >= 1) {
            prog = 1.0;
        }
        this._gesture.action = 0;

        if (vert == 0) {
            this._gesture.action = horiz;
        }
        else {
            if (!this._swipeIsWin) {
                if (horiz && vert == 2) {
                    this._gesture.action = horiz + 4;
                }
                else {
                    this._gesture.action = (vert == 2) ? 4 : 7;
                }
            }
            else {
                if (horiz && vert == 1) {
                    this._gesture.action = horiz + 50;
                }
                else {
                    this._gesture.action = (vert == 2) ?
                        ((this._edgeGestured == 1) ? 53 : 3) :
                        50;
                }
            }
        }

        if (this._gesture.action_cmp &&
            (this._gesture.action != this._gesture.action_cmp)) {
            let aid = this._actionIdGet(this._gesture.action_cmp);
            if (aid) {
                this._runAction(aid, 1, 0);
            }
        }

        this._gesture.progress = prog;
        this._velocityAppend(this._gesture.velocity,
            this._gesture.progress);

        if (this._gesture.action) {
            let aid = this._actionIdGet(this._gesture.action);
            if (aid) {
                if (aid >= 50) {
                    this._activateWindow();
                }
                this._runAction(aid, 0, this._gesture.progress);
            }
            this._gesture.action_cmp = this._gesture.action;
        }

        return Clutter.EVENT_STOP;
    }

    _swipeEnd() {
        if (this._isEdge(WindowEdgeAction.MOVE)) {
            this._hidePreview();
            if (this._isEdge(WindowEdgeAction.MOVE_SNAP_TOP)) {
                if (this._targetWindow.can_maximize()) {
                    this._resetWinPos();
                    this._targetWindow.set_maximize_flags(Meta.MaximizeFlags.BOTH);
                }
            }
            else if (this._isEdge(WindowEdgeAction.MOVE_SNAP_LEFT)) {
                this._resetWinPos();
                this._setSnapWindow(0);
            }
            else if (this._isEdge(WindowEdgeAction.MOVE_SNAP_RIGHT)) {
                this._resetWinPos();
                this._setSnapWindow(1);
            }
            this._hooked = false;
            this._clearVars();
            return Clutter.EVENT_STOP;
        }

        let retval = (!this._swipeIsWin && !this._hooked) ?
            Clutter.EVENT_PROPAGATE : Clutter.EVENT_STOP;
        this._hooked = false;
        if (this._gesture.action) {
            let aid = this._actionIdGet(this._gesture.action);
            if (aid) {
                let issnapaction = (aid == 51 || aid == 52);
                if ((this._gesture.progress < 1.0) && !issnapaction) {
                    let vel = this._velocityCalc(this._gesture.velocity);
                    if (vel > 0.001) {
                        let me = this;
                        this._velocityFling(vel,
                            this._gesture.progress,
                            1.0, 30,
                            function (state, prog) {
                                me._runAction(aid, state, prog);
                            }
                        );
                        this._clearVars();
                        return retval;
                    }
                }
                this._runAction(aid, 1, this._gesture.progress);
            }
        }
        this._clearVars();
        return retval;
    }

    _swipeEventHandler(actor, event) {
        let numfingers = event.get_touchpad_gesture_finger_count();
        if (numfingers != 3 && numfingers != 4) {
            return Clutter.EVENT_PROPAGATE;
        }
        switch (event.get_gesture_phase()) {
            case Clutter.TouchpadGesturePhase.BEGIN:
                return this._swipeBegin(numfingers);
            case Clutter.TouchpadGesturePhase.UPDATE:
                let [dx, dy] = event.get_gesture_motion_delta();
                return this._swipeUpdate(
                    dx * this._getAcceleration(),
                    dy * this._getAcceleration()
                );
        }
        return this._swipeEnd();
    }

    _pinchGetCurrentActionId() {
        if (this._gesture.begin && this._gesture.action != 0) {
            if (this._gesture.action != this._gesture.action_cmp) {
                this._gesture.action_id = this._actionIdGet(
                    (this._gesture.fingers == 3) ?
                        this._gesture.action + 7 :
                        this._gesture.action + 9
                );
                this._gesture.action_cmp = this._gesture.action;
            }
            return this._gesture.action_id;
        }
        return 0;
    }

    _pinchUpdate(pinch_scale) {
        if (this._gesture.begin) {
            let pIn = (this._getPinchInScale() / 100.0);
            let pOut = (this._getPinchOutScale() / 100.0);

            if (pinch_scale < 1.0) {
                if (pinch_scale < pIn) {
                    pinch_scale = pIn;
                }
                this._gesture.action = 1;
                this._gesture.progress = (1.0 - pinch_scale) / (1.0 - pIn);
            }
            else if (pinch_scale > 1.0) {
                if (pinch_scale > pOut) {
                    pinch_scale = pOut;
                }
                this._gesture.action = 2;
                this._gesture.progress = (pinch_scale - 1.0) / (pOut - 1.0);
            }
            else {
                this._gesture.action = 0;
                this._gesture.progress = 0;
            }

            if (this._gesture.action_cmp &&
                (this._gesture.action != this._gesture.action_cmp)) {
                let aid = this._actionIdGet(
                    (this._gesture.fingers == 3) ?
                        this._gesture.action_cmp + 7 :
                        this._gesture.action_cmp + 9
                );
                if (aid) {
                    this._runAction(aid, 1, 0);
                }
                this._gesture.velocity = this._velocityInit();
                this._velocityAppend(this._gesture.velocity, 0);
            }
            this._velocityAppend(this._gesture.velocity,
                this._gesture.progress);

            let action_id = this._pinchGetCurrentActionId();
            if (action_id) {
                this._runAction(action_id, 0,
                    this._gesture.progress
                );
            }
        }
        return Clutter.EVENT_STOP;
    }

    _pinchBegin(numfingers) {
        this._gesture.begin = true;
        this._gesture.fingers = numfingers;
        this._gesture.progress = 0;
        this._gesture.action = 0;
        this._gesture.action_cmp = 0;
        this._gesture.action_id = 0;
        this._gesture.velocity = this._velocityInit();
        this._velocityAppend(this._gesture.velocity, 0);
        return Clutter.EVENT_STOP;
    }

    _pinchEnd() {
        let action_id = this._pinchGetCurrentActionId();
        if (action_id) {
            if (this._gesture.progress < 1.0) {
                let vel = this._velocityCalc(this._gesture.velocity);
                if (vel > 0.001) {
                    let me = this;
                    this._velocityFling(vel,
                        this._gesture.progress,
                        1.0, 30,
                        function (state, prog) {
                            me._runAction(action_id, state, prog);
                        }
                    );
                    this._clearVars();
                    return Clutter.EVENT_STOP;
                }
            }
            this._runAction(action_id, 1, this._gesture.progress);
        }
        this._clearVars();
        return Clutter.EVENT_STOP;
    }

    _pinchEventHandler(actor, event) {
        if (!this._getPinchEnabled()) {
            return Clutter.EVENT_PROPAGATE;
        }
        let numfingers = event.get_touchpad_gesture_finger_count();
        if (numfingers != 3 && numfingers != 4) {
            return Clutter.EVENT_PROPAGATE;
        }
        const pinch_scale = event.get_gesture_pinch_scale();
        switch (event.get_gesture_phase()) {
            case Clutter.TouchpadGesturePhase.BEGIN:
                return this._pinchBegin(numfingers);
            case Clutter.TouchpadGesturePhase.UPDATE:
                return this._pinchUpdate(pinch_scale);
        }
        return this._pinchEnd();
    }

    _tapHoldGesture(state, numfingers) {
        let isWin = (numfingers == this._gestureNumFinger());
        if (!isWin || this._getTapHoldMove()) {
            if (state) {
                let me = this;
                this._holdTo = setTimeout(function () {
                    me._tapHold = 0;
                    let activeWin = null;
                    if (!me._getUseActiveWindow()) {
                        activeWin = me._findPointerWindow();
                    }
                    if (!activeWin) {
                        activeWin = global.display.get_focus_window();
                    }
                    if (activeWin && ((activeWin.allows_move() &&
                        !activeWin.is_maximized()) || !isWin)) {
                        activeWin.activate(
                            Meta.CURRENT_TIME
                        );
                        me._tapHold = numfingers;
                        me._tapHoldWin = activeWin;
                        me._tapHoldTick = 1;
                        activeWin.get_compositor_private()
                            .set_pivot_point(0.5, 0.5);
                        activeWin.get_compositor_private().ease({
                            duration: 100,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                            scale_y: 1.05,
                            scale_x: 1.05,
                            onStopped: () => {
                                activeWin?.get_compositor_private()?.ease({
                                    duration: 100,
                                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                                    scale_y: 1,
                                    scale_x: 1,
                                    onStopped: () => {
                                        activeWin?.get_compositor_private()
                                            ?.set_pivot_point(0, 0);
                                    }
                                });
                            }
                        });
                    }
                }, 100);
            }
            else {
                if (this._holdTo) {
                    clearTimeout(this._holdTo);
                }
                this._tapHoldTick = this._tick() + 100;
                this._holdTo = 0;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _tapHoldHandler(actor, event) {
        let numfingers = event.get_touchpad_gesture_finger_count();
        if (numfingers != 3 && numfingers != 4) {
            return Clutter.EVENT_PROPAGATE;
        }
        if (event.get_gesture_phase() == Clutter.TouchpadGesturePhase.BEGIN) {
            return this._tapHoldGesture(1, numfingers);
        }
        return this._tapHoldGesture(0, numfingers);
    }

    _touchpadEvent(actor, event) {
        if (event.type() == Clutter.EventType.TOUCHPAD_PINCH)
            return this._pinchEventHandler(actor, event);
        if (event.type() == Clutter.EventType.TOUCHPAD_SWIPE)
            return this._swipeEventHandler(actor, event);
        if (event.type() == Clutter.EventType.TOUCHPAD_HOLD)
            return this._tapHoldHandler(actor, event);
        return Clutter.EVENT_PROPAGATE;
    }

    _actionIdGet(type) {
        let cfg_name = "";
        switch (type) {
            case 1: cfg_name = "swipe4-left"; break;
            case 2: cfg_name = "swipe4-right"; break;
            case 3: cfg_name = "swipe4-updown"; break;
            case 4: cfg_name = "swipe3-down"; break;
            case 5: cfg_name = "swipe3-left"; break;
            case 6: cfg_name = "swipe3-right"; break;
            case 7: cfg_name = "swipe3-downup"; break;
            case 8: cfg_name = "pinch3-in"; break;
            case 9: cfg_name = "pinch3-out"; break;
            case 10: cfg_name = "pinch4-in"; break;
            case 11: cfg_name = "pinch4-out"; break;
            case 24: return 24;
            case 25: return 25;
            default:
                if (type >= 50 && type <= 53) {
                    return type;
                }
                return 0;
        }
        return this._settings.get_int(cfg_name);
    }

    // Ease-restore a compositor actor back to normal, then run cleanup
    _easeRestoreActor(actor, progress, cleanup) {
        if (actor) {
            actor.ease({
                duration: Math.round(200 * progress),
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                opacity: 255,
                scale_x: 1,
                scale_y: 1,
                onStopped: () => {
                    actor?.set_pivot_point(0, 0);
                    cleanup();
                }
            });
        } else {
            cleanup();
        }
    }

    _runAction(id, state, progress) {
        const _LCASE = 32;
        if (id == 1) {
            //
            // MINIMIZE ACTION
            //
            if (this._isOnOverview()) {
                return;
            }

            let activeWin = null;
            let ui = this._actionWidgets.minimize;

            if (!ui) {
                activeWin = global.display.get_focus_window();
                if (this._isWindowBlacklist(activeWin)) {
                    activeWin = null;
                }
                if (activeWin && activeWin.can_minimize()) {
                    ui = activeWin.get_compositor_private();
                    this._actionWidgets.minimize = ui;
                    if (ui) {
                        ui.set_pivot_point(0.5, 1);
                    }
                }
                else {
                    this._actionWidgets.minimize = ui = -1;
                }
            }

            if (ui && ui != -1) {
                if (!state) {
                    ui.set_pivot_point(0.5, 1);
                    ui.opacity = 255 - Math.round(100 * progress);
                    ui.scale_x = 1.0 - (0.2 * progress);
                    ui.scale_y = 1.0 - (0.2 * progress);
                }
                else {
                    activeWin = null;
                    if (progress >= 1.0) {
                        activeWin = global.display.get_focus_window();
                        if (activeWin) {
                            if (!activeWin.can_minimize()) {
                                activeWin = null;
                            }
                        }
                    }

                    ui.ease({
                        duration: Math.round(250 * progress),
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        opacity: activeWin ? 0 : 255,
                        scale_x: activeWin ? 0 : 1,
                        scale_y: activeWin ? 0 : 1,
                        onStopped: () => {
                            ui.set_pivot_point(0, 0);
                            if (activeWin) {
                                activeWin.minimize();
                                ui.opacity = 0;
                                ui.ease({
                                    duration: 800,
                                    opacity: 0,
                                    onStopped: () => {
                                        ui.opacity = 255;
                                        ui.scale_x = 1;
                                        ui.scale_y = 1;
                                        ui = null;
                                    }
                                });
                            }
                            else {
                                ui = null;
                            }
                        }
                    });
                    this._actionWidgets.minimize = null;
                }
            } else if (state) {
                this._actionWidgets.minimize = ui = null;
            }
        }
        else if (id == 2) {
            //
            // CLOSE WINDOW ACTION
            //
            if (this._isOnOverview()) {
                return;
            }

            let activeWin = null;
            let ui = this._actionWidgets.close;

            if (!ui) {
                activeWin = global.display.get_focus_window();
                if (this._isWindowBlacklist(activeWin)) {
                    activeWin = null;
                }
                if (activeWin) {
                    ui = activeWin.get_compositor_private();
                    this._actionWidgets.close = ui;
                    if (ui) {
                        ui.set_pivot_point(0.5, 0.5);
                        this._createShader('close', ui, 'closeindicator');
                        ui.fx?.setValue(0);
                    }
                }
                else {
                    this._actionWidgets.close = ui = -1;
                }
            }

            if (ui && ui != -1) {
                if (!state) {
                    ui.set_pivot_point(0.5, 0.5);
                    ui.opacity = 255 - Math.round(40 * progress);
                    ui.scale_x = 1.0 - (progress * 0.08);
                    ui.scale_y = 1.0 - (progress * 0.08);
                    ui.fx?.setValue(progress * 0.99);
                }
                else {
                    activeWin = null;
                    if (progress >= 1.0) {
                        activeWin = global.display.get_focus_window();
                    }

                    ui.fx?.release();
                    ui.set_pivot_point(0, 0);
                    ui.opacity = 255;
                    ui.scale_x = 1.0;
                    ui.scale_y = 1.0;
                    if (activeWin) {
                        activeWin.delete(
                            Meta.CURRENT_TIME
                        );
                        activeWin = null;
                    }
                    ui = null;
                    this._actionWidgets.close = null;
                }
            } else if (state) {
                this._actionWidgets.close = ui = null;
            }
        }
        else if (id == 3) {
            //
            // SHOW DESKTOP
            //
            if (this._isOnOverview()) {
                return;
            }

            let ui = this._actionWidgets.show_desktop;

            if (!ui) {
                let allWindows = global.display.list_all_windows();
                if (allWindows.length > 0) {
                    ui = [];
                    for (let i = 0; i < allWindows.length; i++) {
                        if (!this._isWindowBlacklist(allWindows[i])) {
                            let aui = allWindows[i].get_compositor_private();

                            if (aui) {
                                ui.push(aui);
                                let mrect = allWindows[i]
                                    .get_work_area_current_monitor();
                                let wrect = allWindows[i].get_frame_rect();

                                // Calculate slide-out direction per window
                                let wl = (mrect.width / 32);
                                aui._t_targetx = (mrect.width - wl) - wrect.x;
                                let nx = (0 - (wrect.width - wl)) - wrect.x;
                                aui.set_pivot_point(1.0, 0.5);
                                if (Math.abs(nx) < Math.abs(aui._t_targetx)) {
                                    aui._t_targetx = nx;
                                    aui.set_pivot_point(1, (i % 5) * 0.25);
                                }
                                else {
                                    aui.set_pivot_point(0, (i % 5) * 0.25);
                                }
                            }
                        }
                    }
                    this._actionWidgets.show_desktop = ui;
                }
                else {
                    this._actionWidgets.show_desktop = ui = -1;
                }
            }

            if (ui && ui != -1) {
                if (!state) {
                    ui.forEach((aui) => {
                        aui.opacity = 255 - Math.round(180 * progress);
                        aui.scale_y =
                            aui.scale_x = 1.0 - (progress * 0.6);
                        aui.translation_x = (
                            (progress * progress) * aui._t_targetx
                        );
                    });
                }
                else {
                    if (progress >= 1.0) {
                        this._sendKeyPress(
                            [Clutter.KEY_Super_L,
                            Clutter.KEY_D + _LCASE]
                        );
                    }

                    ui.forEach((aui) => {
                        aui.ease({
                            duration: Math.round(250 * progress),
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                            opacity: 255,
                            translation_x: 0,
                            scale_x: 1,
                            scale_y: 1,
                            onStopped: () => {
                                aui.set_pivot_point(0, 0);
                                delete aui._t_targetx;
                                delete aui._t_targety;
                            }
                        });
                    });

                    this._actionWidgets.show_desktop = ui = null;
                }
            } else if (state) {
                this._actionWidgets.show_desktop = ui = null;
            }

        }
        else if ((id == 4) || (id == 5) || (id == 24) || (id == 25)) {
            //
            // NEXT & PREVIOUS WINDOW/APPLICATION SWITCHING
            //
            if (this._isOnOverview()) {
                return;
            }

            let prv = (id == 5 || id == 25);
            let wid = prv ? "switchwin_prev" : "switchwin_next";
            let ui = this._actionWidgets[wid];
            let isAppSwitching = (id == 24 || id == 25);

            // Init indicator
            if (!ui) {
                ui = -1;
                let wins = null;
                let listActor = null;

                if (this._actionWidgets.resetWinlist) {
                    clearTimeout(this._actionWidgets.resetWinlist);
                    this._actionWidgets.resetWinlist = 0;
                }
                // Get cached window/app list
                if (isAppSwitching) {
                    if (this._actionWidgets.cacheAppTabList) {
                        wins = this._actionWidgets.cacheAppTabList?.apps;
                        listActor = this._actionWidgets.cacheAppTabList?.actor;
                    }
                } else {
                    if (this._actionWidgets.cacheWinTabList) {
                        wins = this._actionWidgets.cacheWinTabList?.wins;
                        listActor = this._actionWidgets.cacheWinTabList?.actor;
                    }
                }
                if (!wins) {
                    let useFixedOrder = this._settings.get_boolean('fixed-window-order');
                    if (isAppSwitching) {
                        wins = this._getApplicationList(useFixedOrder);
                    } else {
                        wins = this._getWindowTabList(useFixedOrder);
                    }
                    if (wins.length > 1) {
                        let gsize = Main.layoutManager.uiGroup.get_size();
                        let pad = 8;
                        let posCfg = this._settings.get_int(
                            'winswitch-position'
                        );
                        let monitor = global.display.get_primary_monitor();
                        let scale = global.display.get_monitor_scale(monitor);
                        let lW = ((pad * 2) + (wins.length * 48)) * scale;
                        let lH = ((pad * 2) + 32) * scale;
                        let lX = (gsize[0] - lW) / 2;
                        let lY = 64;
                        let pivY = 0;
                        if (posCfg == 1) {
                            lY = (gsize[1] - lH) / 2;
                            pivY = 0.5;
                        }
                        else if (posCfg == 2) {
                            lY = gsize[1] - (lH + 64 * scale);
                            pivY = 1;
                        }
                        listActor = this._createUi(
                            isAppSwitching ? "wgs-appswitch" : "wgs-winswitch", lX, lY, lW, lH
                        );
                        listActor.set_pivot_point(0.5, pivY);
                        listActor.opacity = 0;
                        listActor.scale_x = listActor.scale_y = 0.5;
                        listActor._data = [];
                        let iconSize = 32 * scale;
                        for (let i = 0; i < wins.length; i++) {
                            let item = wins[i];
                            let ico, app, win;

                            if (isAppSwitching) {
                                app = item.app;
                                win = item.activeWindow;
                                ico = app.create_icon_texture(iconSize);
                                ico.add_style_class_name("wgs-appswitch-ico");
                            } else {
                                win = item;
                                app = this._winmanWinApp(win);
                                ico = app.create_icon_texture(iconSize);
                                ico.add_style_class_name("wgs-winswitch-ico");
                            }
                            listActor.add_child(ico);
                            ico.set_size(iconSize, iconSize);
                            ico.set_position(((pad * 2) + (48 * i)) * scale, pad * scale);
                            ico.set_pivot_point(0.5, 0.5);

                            if (isAppSwitching) {
                                listActor._data.push({
                                    app: app,
                                    windows: item.windows,
                                    activeWindow: win,
                                    ico: ico
                                });
                            } else {
                                listActor._data.push({
                                    app: app,
                                    win: win,
                                    ico: ico
                                });
                            }
                        }
                        listActor.viewShow({
                            opacity: 255,
                            scale_x: 1.0,
                            scale_y: 1.0
                        }, 200);

                        let currentIndex = 0;

                        if (useFixedOrder) {
                            let activeWindow = global.display.get_focus_window();
                            if (activeWindow) {
                                if (isAppSwitching) {
                                    let activeApp = this._winmanWinApp(activeWindow);
                                    currentIndex = wins.findIndex(item => item.app === activeApp);
                                } else {
                                    currentIndex = wins.findIndex(win => win === activeWindow);
                                }
                            }
                            if (currentIndex === -1) {
                                currentIndex = 0;
                            }
                        }

                        if (isAppSwitching) {
                            this._actionWidgets.cacheAppTabList = {
                                sel: 0,
                                first: wins[0],
                                apps: wins,
                                actor: listActor,
                                useFixedOrder: useFixedOrder,
                                currentIndex: currentIndex
                            };
                        } else {
                            this._actionWidgets.cacheWinTabList = {
                                sel: 0,
                                first: wins[0],
                                wins: wins,
                                actor: listActor,
                                useFixedOrder: useFixedOrder,
                                currentIndex: currentIndex
                            };
                        }
                    }
                    else {
                        if (isAppSwitching) {
                            this._actionWidgets.cacheAppTabList = null;
                        } else {
                            this._actionWidgets.cacheWinTabList = null;
                        }
                    }
                }
                if (wins.length > 1) {
                    let useFixedOrder = this._settings.get_boolean('fixed-window-order');
                    let cache = isAppSwitching ? this._actionWidgets.cacheAppTabList : this._actionWidgets.cacheWinTabList;

                    if (useFixedOrder && cache && cache.useFixedOrder) {
                        let currentIndex = cache.currentIndex;
                        let nextIndex;

                        if (prv) {
                            nextIndex = (currentIndex - 1 + wins.length) % wins.length;
                        } else {
                            nextIndex = (currentIndex + 1) % wins.length;
                        }

                        ui = {
                            from: wins[currentIndex],
                            into: wins[nextIndex],
                            nsel: prv ? -1 : 1,
                            lstate: 0,
                            currentIndex: currentIndex,
                            nextIndex: nextIndex
                        };
                    } else {
                        let activeWindow = global.display.get_focus_window();
                        let fromIndex = 0;

                        if (activeWindow) {
                            if (isAppSwitching) {
                                let activeApp = this._winmanWinApp(activeWindow);
                                fromIndex = wins.findIndex(item => item.app === activeApp);
                            } else {
                                fromIndex = wins.findIndex(win => win === activeWindow);
                            }
                        }

                        if (fromIndex === -1) {
                            fromIndex = 0;
                        }

                        let toIndex;
                        if (prv) {
                            toIndex = (fromIndex - 1 + wins.length) % wins.length;
                        } else {
                            toIndex = (fromIndex + 1) % wins.length;
                        }

                        ui = {
                            from: wins[fromIndex],
                            into: wins[toIndex],
                            nsel: prv ? -1 : 1,
                            lstate: 0
                        };
                    }

                    if (isAppSwitching) {
                        ui.from_actor = ui.from.activeWindow.get_compositor_private();
                        ui.into_actor = ui.into.activeWindow.get_compositor_private();
                    } else {
                        ui.from_actor = ui.from.get_compositor_private();
                        ui.into_actor = ui.into.get_compositor_private();
                    }
                    ui.from_actor.set_pivot_point(0.5, 1);
                    ui.into_actor.set_pivot_point(0.5, 1);

                    for (let i = 0; i < listActor._data.length; i++) {
                        let d = listActor._data[i];
                        let fromMatch, intoMatch;

                        if (isAppSwitching) {
                            fromMatch = (d.app == ui.from.app);
                            intoMatch = (d.app == ui.into.app);
                        } else {
                            fromMatch = (d.win == ui.from);
                            intoMatch = (d.win == ui.into);
                        }

                        if (fromMatch) {
                            d.ico.add_style_class_name("selected");
                            ui.from_ico = d.ico;
                        }
                        else if (intoMatch) {
                            d.ico.remove_style_class_name("selected");
                            ui.into_ico = d.ico;
                        }
                        else {
                            d.ico.remove_style_class_name("selected");
                        }
                    }
                }
                this._actionWidgets[wid] = ui;
            }
            if (ui && ui != -1) {
                let useStableSwitching = this._settings.get_boolean('stable-window-switching');

                if (!state) {
                    if (ui.from_actor) {
                        ui.from_actor.opacity = 255 - Math.round(80 * progress);
                        ui.from_actor.scale_y =
                            ui.from_actor.scale_x = 1.0 - (0.05 * progress);
                    }
                    if (ui.into_actor) {
                        ui.into_actor.scale_y =
                            ui.into_actor.scale_x = 1.0 + (0.05 * progress);
                    }

                    let shouldSwitch = useStableSwitching ? (progress > 0.1) : (progress > 0.8);

                    if (shouldSwitch) {
                        if (!ui.lstate) {
                            if (isAppSwitching) {
                                ui.into?.activeWindow?.raise();
                            } else {
                                ui.into?.raise();
                            }
                            ui.lstate = 1;
                            ui.from_ico?.remove_style_class_name("selected");
                            ui.into_ico?.add_style_class_name("selected");
                        }
                    }
                    else if (ui.lstate) {
                        if (isAppSwitching) {
                            ui.from?.activeWindow?.raise();
                        } else {
                            ui.from?.raise();
                        }
                        ui.lstate = 0;
                        ui.from_ico?.add_style_class_name("selected");
                        ui.into_ico?.remove_style_class_name("selected");
                    }
                }
                else {
                    // shouldComplete is always true when stable switching,
                    // otherwise requires sufficient progress or visual switch
                    let shouldComplete = useStableSwitching || (progress > 0.8) || ui.lstate;

                    if (shouldComplete) {
                        // Activate first, raise from, activate into
                        if (isAppSwitching) {
                            this._actionWidgets.cacheAppTabList
                                ?.first?.activeWindow?.activate(Meta.CURRENT_TIME);
                            ui.from?.activeWindow?.raise();
                            ui.into?.activeWindow?.activate(Meta.CURRENT_TIME);
                        } else {
                            this._actionWidgets.cacheWinTabList
                                ?.first?.activate(Meta.CURRENT_TIME);
                            ui.from?.raise();
                            ui.into?.activate(Meta.CURRENT_TIME);
                        }

                        // Update cache order
                        let cache = isAppSwitching
                            ? this._actionWidgets.cacheAppTabList
                            : this._actionWidgets.cacheWinTabList;
                        if (cache && cache.useFixedOrder && ui.nextIndex !== undefined) {
                            cache.currentIndex = ui.nextIndex;
                        } else if (cache) {
                            let list = isAppSwitching ? cache.apps : cache.wins;
                            if (list?.length > 0) {
                                if (prv) {
                                    list.unshift(list.pop());
                                } else {
                                    list.push(list.shift());
                                }
                            }
                        }
                        ui.from_ico?.remove_style_class_name("selected");
                        ui.into_ico?.add_style_class_name("selected");
                    }
                    else {
                        // Gesture cancelled - not enough progress
                        ui.from_ico?.add_style_class_name("selected");
                        ui.into_ico?.remove_style_class_name("selected");
                    }

                    // Ease-restore both actors
                    ui.nclose = 0;
                    this._easeRestoreActor(ui.from_actor, progress, () => {
                        ui.from_actor = null;
                        ui.from = null;
                        if (++ui.nclose == 2) {
                            ui = null;
                        }
                    });
                    this._easeRestoreActor(ui?.into_actor, progress, () => {
                        if (ui) {
                            ui.into_actor = null;
                            ui.into = null;
                            if (++ui.nclose == 2) {
                                ui = null;
                            }
                        }
                    });

                    this._actionWidgets[wid] = null;

                    // Clear cache after timeout
                    let me = this;
                    if (isAppSwitching) {
                        this._actionWidgets.resetApplist = setTimeout(
                            function () {
                                me._actionWidgets.cacheAppTabList?.actor?.aniRelease();
                                me._actionWidgets.cacheAppTabList = null;
                                clearTimeout(me._actionWidgets.resetApplist);
                                me._actionWidgets.resetApplist = 0;
                            }, 500
                        );
                    } else {
                        this._actionWidgets.resetWinlist = setTimeout(
                            function () {
                                me._actionWidgets.cacheWinTabList?.actor?.aniRelease();
                                me._actionWidgets.cacheWinTabList = null;
                                clearTimeout(me._actionWidgets.resetWinlist);
                                me._actionWidgets.resetWinlist = 0;
                            }, 500
                        );
                    }
                }
            } else if (state) {
                this._actionWidgets[wid] = ui = null;
            }
        }

        else if ((id == 6) || (id == 7)) {
            //
            // SEND WINDOW LEFT/RIGHT WORKSPACE
            //
            if (this._isOnOverview()) {
                return;
            }

            let prv = (id == 6);
            let wid = prv ? "movewin_left" : "movewin_right";
            let ui = this._actionWidgets[wid];
            let activeWin = null;

            if (!ui) {
                ui = -1;
                let isDynamic = this._isDynamicWorkspace();
                activeWin = global.display.get_focus_window();
                let inserted = 0;
                if (activeWin) {
                    let wsid = activeWin.get_workspace().index();
                    let tsid = wsid;
                    if (prv) {
                        if (isDynamic) {
                            if (wsid == 0) {
                                let wpl = activeWin.get_workspace().list_windows();
                                inserted = wpl.length;
                                if (inserted > 1) {
                                    for (let i = 0; i < inserted; i++) {
                                        if (this._isWindowBlacklist(wpl[i])) {
                                            inserted--;
                                        }
                                    }
                                }
                                wsid = tsid = 1;
                            }
                        }
                        else {
                            if (wsid == 0) {
                                inserted = 1;
                            }
                        }
                        tsid--;
                    }
                    else {
                        if (!isDynamic && (wsid >=
                            global.workspace_manager.get_n_workspaces() - 1)) {
                            inserted = 1;
                        }
                        tsid++;
                    }
                    if (inserted !== 1) {
                        activeWin.stick();
                        if (inserted) {
                            this._insertWorkspace(0);
                        }
                        ui = {
                            confirmSwipe: () => { },
                            wm: Main.wm._workspaceAnimation,
                            win: activeWin,
                            wid: tsid,
                            sid: wsid,
                            ins: inserted
                        };
                        ui.wm._switchWorkspaceBegin(
                            ui,
                            global.display.get_primary_monitor()
                        );
                    }
                }
                this._actionWidgets[wid] = ui;
            }
            if (ui && ui != -1) {
                if (!state) {
                    ui.wm._switchWorkspaceUpdate(
                        ui,
                        ui.sid + ((prv) ? 0 - progress : progress)
                    );
                }
                else {
                    ui.win.unstick();
                    ui.wm._switchWorkspaceEnd(
                        ui, 350,
                        ui.sid + ((prv) ? 0 - progress : progress)
                    );
                    if (progress > 0.5) {
                        ui.win.change_workspace_by_index(
                            ui.wid, true
                        );
                        global.workspace_manager.get_workspace_by_index(ui.wid)
                            .activate(
                                Meta.CURRENT_TIME
                            );
                    }
                    else if (ui.ins) {
                        if (ui.ins > 1) {
                            ui.win.change_workspace_by_index(
                                ui.sid, true
                            );
                        }
                        else {
                            ui.win.change_workspace_by_index(
                                ui.wid, true
                            );
                        }
                    }
                    ui.win.activate(Meta.CURRENT_TIME);
                    this._actionWidgets[wid] = ui = null;
                }
            } else if (state) {
                this._actionWidgets[wid] = ui = null;
            }
        }

        else if (id >= 8 && id <= 9) {
            //
            // BACK / FORWARD
            //
            if (this._isOnOverview()) {
                return;
            }

            const keyList = [
                Clutter.KEY_Back,
                Clutter.KEY_Forward
            ];
            let kid = id - 8;
            let activeWin = null;
            let kidw = kid ? 'btnforward' : 'btnback';
            let ui = this._actionWidgets[kidw];

            if (!ui) {
                let display = global.display;
                activeWin = display.get_focus_window();
                if (this._isWindowBlacklist(activeWin)) {
                    activeWin = null;
                }
                if (activeWin) {
                    let wrect = activeWin.get_frame_rect();
                    let primary_monitor = display.get_primary_monitor();
                    let primary_scale = display.get_monitor_scale(primary_monitor);
                    let win_monitor = activeWin.get_monitor();
                    let win_scale = 1.0;
                    if (win_monitor >= 0) {
                        win_scale = display.get_monitor_scale(win_monitor);
                    }
                    let uisize = 64 * primary_scale;
                    let uix = wrect.x;
                    let uiy = wrect.y + (wrect.height / 2) - uisize / 2;
                    if (kid) {
                        uix += wrect.width - uisize - 64 * win_scale;
                    }
                    else {
                        uix += 64 * win_scale;
                    }
                    ui = this._createUi(
                        'wgs-indicator-backforward',
                        uix,
                        uiy,
                        uisize, uisize,
                        kid ? 'pan-end-symbolic.symbolic' :
                            'pan-start-symbolic.symbolic',
                    );
                    ui.scale_x = ui.scale_y = win_scale / primary_scale;
                    if (ui) {
                        ui.translation_x = kid ? -32 : 32;
                        ui.opacity = 0;
                    }
                    else {
                        ui = -1;
                    }
                    this._actionWidgets[kidw] = ui;
                }
                else {
                    this._actionWidgets[kidw] = -1;
                }
            }

            if (ui && ui != -1) {
                if (!state) {
                    if (kid) {
                        ui.translation_x = 32 - (32 * progress);
                    }
                    else {
                        ui.translation_x = (32 * progress) - 32;
                    }
                    ui.opacity = Math.round(255 * progress);
                }
                else {
                    if (progress >= 1.0) {
                        this._sendKeyPress([keyList[kid]]);
                    }
                    ui.release();
                    this._actionWidgets[kidw] = ui = null;
                }
            } else if (state) {
                this._actionWidgets[kidw] = ui = null;
            }
        }
        else if (id >= 10 && id <= 17) {
            //
            // MEDIA & BRIGHTNESS
            //
            const keyList = [
                Clutter.KEY_MonBrightnessUp,
                Clutter.KEY_MonBrightnessDown,
                Clutter.KEY_AudioRaiseVolume,
                Clutter.KEY_AudioLowerVolume,
                Clutter.KEY_AudioMute,
                Clutter.KEY_AudioPlay,
                Clutter.KEY_AudioNext,
                Clutter.KEY_AudioPrev
            ];
            let cid = 'keysn_' + id;
            let keyId = keyList[id - 10];
            let isRepeat = (id < 14);
            let kidw = 'keyaction_' + id;
            let ui = this._actionWidgets[kidw];

            if (isRepeat) {
                if (!state && (progress >= 1)) {
                    if (!this._keyRepeatInterval) {
                        this._actionWidgets[cid] = 0;
                        this._sendKeyPress([keyId]);
                        this._keyRepeatInterval = setInterval(
                            function (me, cid, keyId) {
                                if (me._actionWidgets[cid] >= 5) {
                                    me._sendKeyPress([keyId]);
                                }
                                else {
                                    me._actionWidgets[cid]++;
                                }
                            },
                            100,
                            this, cid, keyId
                        );
                    }
                }
                if (state) {
                    if (this._keyRepeatInterval) {
                        clearInterval(this._keyRepeatInterval);
                    }
                    this._keyRepeatInterval = 0;
                    this._actionWidgets[cid] = 0;
                }
            }
            else {
                let display = global.display;
                let monitor = display.get_primary_monitor();
                let scale = display.get_monitor_scale(monitor);
                if (!ui) {
                    const iconlist = [
                        'audio-volume-muted-symbolic',
                        'media-playback-start-symbolic',
                        'media-skip-forward-symbolic',
                        'media-skip-backward-symbolic'
                    ];
                    let mrect = display.get_monitor_geometry(monitor);
                    let uisize = 128 * scale;
                    ui = this._createUi(
                        'wgs-indicator-keys',
                        mrect.x + (mrect.width / 2) - (uisize / 2),
                        mrect.y + (mrect.height / 2) - (uisize / 2),
                        uisize, uisize,
                        iconlist[id - 14],
                    );
                    ui.opacity = 0;
                    ui.scale_x = ui.scale_y = 0;
                    this._actionWidgets[kidw] = ui;
                }

                if (ui && ui != -1) {
                    if (!state) {
                        ui.scale_x = ui.scale_y = progress / scale;
                        ui.opacity = Math.round(255 * progress);
                    }
                    else {
                        if (progress >= 1.0) {
                            this._sendKeyPress([keyId]);
                        }
                        ui.aniRelease(progress);
                        this._actionWidgets[kidw] = ui = null;
                    }
                }
                else if (state) {
                    this._actionWidgets[kidw] = ui = null;
                }
            }

        }

        //
        // Non animated actions
        //
        else if (id == 18) {
            if (this._isOnOverview()) {
                return;
            }
            if (!state || progress < 1.0) {
                return;
            }
            this._sendKeyPress([Clutter.KEY_Alt_L, Clutter.KEY_Tab]);
        }
        else if (id == 19 || id == 20) {
            if (!state || progress < 1.0) {
                return;
            }
            if (id == 19) {
                Main.overview.show();
            }
            else {
                Main.overview.showApps();
            }
        }
        else if (id == 21) {
            if (!state || progress < 1.0) {
                return;
            }
            Main.wm._toggleQuickSettings();
        }
        else if (id == 22) {
            if (!state || progress < 1.0) {
                return;
            }
            Main.wm._toggleCalendar();
        }
        else if (id == 23) {
            if (!state || progress < 1.0) {
                return;
            }
            this._sendKeyPress([Clutter.KEY_Alt_L, Clutter.KEY_F2]);
        }

        else if (id >= 50 && id <= 53) {
            //
            // Maximized, Fullscreen, Snap Etc.
            //
            let activeWin = global.display.get_focus_window();
            if (!activeWin || this._isOnOverview()) {
                return;
            }
            if (this._isWindowBlacklist(activeWin)) {
                return;
            }

            let winCanMax = activeWin.allows_move() && activeWin.can_maximize();
            let winIsMaximized = activeWin.is_maximized();
            if (typeof winIsMaximized !== "boolean") {
                winIsMaximized = winIsMaximized !== Meta.MaximizeFlags.NONE;
            }
            let winMaxed = !!winIsMaximized;
            if (activeWin.isTiled) {
                winIsMaximized = true;
            }
            let winIsFullscreen = activeWin.is_fullscreen();
            let allowFullscreen = this._getEnableFullscreen();
            let ui = 0;
            if (id < 53) {
                if (winMaxed) {
                    if (winIsFullscreen) {
                        ui = 5;
                    }
                    else if (allowFullscreen) {
                        ui = 4;
                    }
                    else {
                        ui = 6;
                    }
                }
                else if (winCanMax) {
                    ui = id - 49;
                }
            }
            else if (winIsFullscreen) {
                ui = 5;
            }
            else if (winIsMaximized) {
                ui = 6;
            }
            let wid = "wmax_state" + ui;

            if (ui) {
                if (!state) {
                    if (ui == 4) {
                        activeWin?.get_compositor_private()
                            .set_pivot_point(0.5, 1);
                        activeWin.get_compositor_private().scale_y =
                            1.0 + (progress * 0.025);
                    }
                    else if (ui >= 5) {
                        activeWin?.get_compositor_private()
                            .set_pivot_point(0.5, 1);
                        if (ui == 6) {
                            activeWin.get_compositor_private().scale_y =
                                activeWin.get_compositor_private().scale_x =
                                1.0 - (progress * 0.04);
                        }
                        else {
                            activeWin.get_compositor_private().scale_y =
                                1.0 - (progress * 0.025);
                        }
                    }
                    else if (ui <= 3) {
                        if (!this._actionWidgets[wid]) {
                            if (this._actionWidgets.tilerHider) {
                                clearTimeout(this._actionWidgets.tilerHider);
                                this._actionWidgets.tilerHider = null;
                            }
                            let moarea = activeWin
                                .get_work_area_current_monitor();
                            if (ui == 1) {
                                this._showPreview(
                                    moarea.x,
                                    moarea.y,
                                    moarea.width,
                                    moarea.height
                                );
                            }
                            else if (ui == 2) {
                                this._showPreview(
                                    moarea.x,
                                    moarea.y,
                                    moarea.width / 2,
                                    moarea.height
                                );
                            }
                            else if (ui == 3) {
                                this._showPreview(
                                    moarea.x
                                    + (moarea.width / 2),
                                    moarea.y,
                                    moarea.width / 2,
                                    moarea.height
                                );
                            }
                            this._actionWidgets[wid] = 1;
                        }
                    }
                }
                else {
                    if (ui <= 3) {
                        if (this._actionWidgets.tilerHider) {
                            clearTimeout(this._actionWidgets.tilerHider);
                            this._actionWidgets.tilerHider = null;
                        }
                        if (this._actionWidgets[wid] && (progress > 0)) {
                            if (ui == 1) {
                                activeWin.set_maximize_flags(Meta.MaximizeFlags.BOTH);
                            }
                            else if (ui == 2) {
                                this._setSnapWindow(0);
                            }
                            else if (ui == 3) {
                                this._setSnapWindow(1);
                            }
                        }
                        this._actionWidgets.tilerHider = setTimeout(
                            function (me) {
                                me._hidePreview();
                                me._actionWidgets.tilerHider = null;
                            }, 100, this);
                        this._actionWidgets[wid] = 0;
                    }
                    else {
                        activeWin?.get_compositor_private().ease({
                            duration: Math.round(200 * progress),
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                            scale_y: 1,
                            scale_x: 1,
                            onStopped: () => {
                                activeWin?.get_compositor_private()
                                    .set_pivot_point(0, 0);
                            }
                        });
                        if (progress >= 0.5) {
                            if (ui == 4) {
                                activeWin.make_fullscreen();
                            }
                            else if (ui == 5) {
                                activeWin.unmake_fullscreen();
                            }
                            else if (ui == 6) {
                                activeWin.set_unmaximize_flags(
                                    Meta.MaximizeFlags.BOTH
                                );
                                if (activeWin.isTiled) {
                                    this._sendKeyPress([
                                        Clutter.KEY_Super_L, Clutter.KEY_Down
                                    ]);
                                }
                            }
                        }
                    }
                }
            }
        }
        //
        // End Of Actions
        //
    }

    _getProcessCreationTime(pid) {
        try {
            let [success, contents] =
                Gio.File.new_for_path(`/proc/${pid}/stat`).load_contents(null);
            if (success) {
                let statData = new TextDecoder().decode(contents).split(' ');
                return parseInt(statData[21]);
            }
        } catch (_) {
            // Process may have exited or /proc may be inaccessible
        }
        return Number.MAX_SAFE_INTEGER;
    }
}

// Export Extension
export default class WindowGesturesExtension extends Extension {
    enable() {
        this.manager = new Manager(this);
    }
    disable() {
        this.manager.destroy();
        this.manager = null;
    }
}
