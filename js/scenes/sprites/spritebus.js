/*
 * spritebus.js — WebSocket bridge between the sprites scene and server.js.
 *
 * Commands IN:   MCP bridge -> server.js DataStore -> ws broadcast -> EventBus "object"
 *                -> here -> onCommand(state) for state.type === 'spriteCmd'
 * Desk map IN:   python desk service publishes deskMap objects (id 900001);
 *                -> here -> onDeskMap(map)
 * State OUT:     we publish spriteState (id 900002) + relay browser logs as
 *                {type:"log"} messages so headset-side behavior shows in the
 *                server terminal.
 *
 * Instantiates window.wsclient (never created anywhere else in the app today).
 */

import { Client as WSClient } from '../../util/websocket-client.js';

const TAG = '[spritebus]';
const DESKMAP_ID = 900001;
const SPRITESTATE_ID = 900002;
const WS_PORT = 8447;

const log = (...a) => console.log(TAG, ...a);

export function connect({ onCommand, onDeskMap } = {}) {
   if (!window.wsclient) {
      window.wsclient = new WSClient();
      log('created wsclient, connecting to', location.hostname + ':' + WS_PORT);
      window.wsclient.connect(location.hostname, WS_PORT);
   } else {
      log('reusing existing wsclient');
   }

   const relayLog = (msg) => {
      // send to server.js which prints it as [browser:spritebus] ...
      try {
         if (window.wsclient && window.wsclient.ws && window.wsclient.ws.readyState === 1)
            window.wsclient.ws.send(JSON.stringify({
               type: 'log', tag: 'spritebus', msg, ts: Date.now() }));
      } catch (e) { /* relay is best-effort */ }
   };

   let initedObjs = false;

   // The stock Client never reconnects; if the relay restarts the scene would
   // freeze silently. Re-create the client on close and redo objectInit.
   const hardenReconnect = () => {
      const ws = window.wsclient?.ws;
      if (!ws) return;
      const prevClose = ws.onclose;
      ws.onclose = (ev) => {
         try { prevClose && prevClose(ev); } catch (e) { /* original handler */ }
         log('ws closed - reconnecting in 2s');
         setTimeout(() => {
            try {
               window.wsclient = new WSClient();
               window.wsclient.connect(location.hostname, WS_PORT);
               initedObjs = false;      // relay DataStore is fresh after a restart
               hardenReconnect();
               log('reconnected');
            } catch (err) { console.error(TAG, 'reconnect failed', err); }
         }, 2000);
      };
   };
   hardenReconnect();

   const ensureObjects = () => {
      // create the DataStore entries once (objid != 0 => fixed environment id)
      if (initedObjs || !window.wsclient || !window.wsclient.ws || window.wsclient.ws.readyState !== 1) return;
      window.wsclient.send('objectInit', { objid: SPRITESTATE_ID, type: 'spriteState', chars: [] });
      initedObjs = true;
      log('objectInit sent for spriteState id', SPRITESTATE_ID);
      relayLog('spriteState object initialized');
   };

   const subscriber = (json) => {
      try {
         // server broadcasts dirty objects as {type:"object", data:{id:{state}}};
         // direct updates arrive as {type:"object", id, state}
         const entries = [];
         if (json && json.data) {
            for (const id of Object.keys(json.data)) {
               const o = json.data[id];
               if (o && o.state) entries.push({ id: Number(id), state: o.state });
            }
         } else if (json && json.state && json.id !== undefined) {
            entries.push({ id: Number(json.id), state: json.state });
         }
         for (const { id, state } of entries) {
            if (!state || typeof state !== 'object') continue;
            if (state.type === 'spriteCmd' && onCommand) {
               log('command received:', JSON.stringify(state));
               relayLog('cmd char=' + state.char + ' ' + state.cmd + ' ' + JSON.stringify(state.args || {}));
               onCommand(state);
            }
            if (state.type === 'deskMap' && onDeskMap) {
               log('deskMap received: status=' + state.status +
                  (state.desk ? ' plane=' + state.desk.dMm + 'mm' : '') +
                  ' obstacles=' + (state.obstacles ? state.obstacles.length : 0));
               onDeskMap(state);
            }
         }
      } catch (err) {
         console.error(TAG, 'subscriber error', err);
      }
   };

   window.EventBus.subscribe('object', subscriber);

   let lastStateSend = 0;
   return {
      publishState(chars, force = false) {
         const now = Date.now();
         if (!force && now - lastStateSend < 500) return;      // <= 2 Hz
         lastStateSend = now;
         ensureObjects();
         try {
            window.wsclient.send('object', {
               id: SPRITESTATE_ID,
               state: { type: 'spriteState', ts: now, chars },
            });
         } catch (err) { console.error(TAG, 'publishState failed', err); }
      },
      relayLog,
      disconnect() {
         window.EventBus.unsubscribe?.('object', subscriber);
         log('disconnected');
      },
   };
}
