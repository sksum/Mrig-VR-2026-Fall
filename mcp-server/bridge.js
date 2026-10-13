/*
 * bridge.js — WebSocket bridge between the MCP server and server.js (DataStore).
 *
 * - Sends sprite commands: {type:"objectInit"|"object", ..., state:{type:"spriteCmd", char, cmd, args}}
 *   using a small rotating pool of object ids (1001-1004) so consecutive commands
 *   never overwrite each other before the 10 Hz dirty broadcast picks them up.
 * - Caches the latest deskMap (id 900001, published by python/realsense_desk_service.py)
 *   and spriteState (id 900002, published by the browser scene) from broadcasts.
 */

const WebSocket = require('ws');
const https = require('https');

const TAG = '[bridge]';
const log = (...a) => console.log(new Date().toISOString(), TAG, ...a);

const CMD_ID_POOL = [1001, 1002, 1003, 1004];

class SceneBridge {
   constructor(url = 'wss://localhost:8447') {
      this.url = url;
      this.ws = null;
      this.deskMap = null;
      this.spriteState = null;
      this.connected = false;
      this.cmdSlot = 0;
      this.initedSlots = new Set();
      this.lastCommandAt = 0;
      this._connect();
   }

   _connect() {
      log('connecting to', this.url);
      // self-signed cert on server.js
      const ws = new WebSocket(this.url, { rejectUnauthorized: false });
      this.ws = ws;

      ws.on('open', () => {
         this.connected = true;
         log('connected to scene server');
      });

      ws.on('message', (data) => {
         try {
            const json = JSON.parse(data.toString());
            if (json.type !== 'object' || !json.data) return;
            for (const id of Object.keys(json.data)) {
               const o = json.data[id];
               if (!o || !o.state) continue;
               if (o.state.type === 'deskMap') {
                  this.deskMap = o.state;
                  if (o.state.status === 'ok') {
                     log('deskMap update: plane=' + (o.state.desk ? o.state.desk.dMm : '?') +
                        'mm obstacles=' + (o.state.obstacles || []).length);
                  }
               } else if (o.state.type === 'spriteState') {
                  this.spriteState = o.state;
               }
            }
         } catch (e) { /* ignore bad frames */ }
      });

      ws.on('close', () => {
         this.connected = false;
         this.initedSlots.clear();   // the relay's in-memory DataStore is empty after a restart
         log('disconnected - reconnecting in 2s');
         setTimeout(() => this._connect(), 2000);
      });

      ws.on('error', (e) => {
         log('ws error:', e.message);
      });
   }

   _send(obj) {
      if (!this.connected || this.ws.readyState !== WebSocket.OPEN) {
         throw new Error('scene server not connected (is server.js running? is the scene page open?)');
      }
      this.ws.send(JSON.stringify(obj));
   }

   sendCommand(char, cmd, args = {}) {
      const id = CMD_ID_POOL[this.cmdSlot % CMD_ID_POOL.length];
      this.cmdSlot++;

      if (!this.initedSlots.has(id)) {
         // first use of this slot: create the DataStore object
         this._send({
            type: 'objectInit', ts: Date.now(), uid: 'mcp-bridge',
            state: { objid: id, type: 'spriteCmd', char, cmd, args },
         });
         this.initedSlots.add(id);
         log('objectInit slot', id);
      } else {
         this._send({
            type: 'object', ts: Date.now(), uid: 'mcp-bridge',
            id, state: { type: 'spriteCmd', char, cmd, args },
         });
      }
      this.lastCommandAt = Date.now();
      log('command sent: char=%s cmd=%s args=%s (slot %s)', char, cmd, JSON.stringify(args), id);
      return { queued: true, slot: id };
   }

   status() {
      return {
         bridgeConnected: this.connected,
         sceneStateFresh: this.spriteState ? Date.now() - this.spriteState.ts < 10000 : false,
         deskMapStatus: this.deskMap ? this.deskMap.status : 'none',
         deskMapFresh: this.deskMap ? Date.now() - this.deskMap.ts * 1000 < 5000 : false,
      };
   }
}

module.exports = { SceneBridge };
