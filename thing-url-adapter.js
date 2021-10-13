/**
 * example-plugin-adapter.js - ThingURL adapter implemented as a plugin.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

'use strict';

const crypto = require('crypto');
const dnssd = require('dnssd');
const fetch = require('node-fetch');
const manifest = require('./manifest.json');
const {URL} = require('url');
const WebSocket = require('ws');

const {
  Adapter,
  Database,
  Device,
  Event,
  Property,
} = require('gateway-addon');

let webthingBrowser;
let subtypeBrowser;
let httpBrowser;

const ACTION_STATUS = 'actionStatus';
const ADD_EVENT_SUBSCRIPTION = 'addEventSubscription';
const EVENT = 'event';
const PROPERTY_STATUS = 'propertyStatus';
const SET_PROPERTY = 'setProperty';

const PING_INTERVAL = 30 * 1000;
const POLL_INTERVAL = 5 * 1000;
const WS_INITIAL_BACKOFF = 1000;
const WS_MAX_BACKOFF = 30 * 1000;

function getHeaders(authentication, includeContentType = false) {
  const headers = {
    Accept: 'application/json',
  };

  if (includeContentType) {
    headers['Content-Type'] = 'application/json';
  }

  switch (authentication.method) {
    case 'jwt':
      headers.Authorization = `Bearer ${authentication.token}`;
      break;
    case 'basic':
    case 'digest':
    default:
      // not implemented
      break;
  }

  return headers;
}

function loadThingURLAdapter(addonManager) {
  const adapter = new ThingURLAdapter(addonManager);

  const db = new Database(manifest.id);
  db.open().then(() => {
    return db.loadConfig();
  }).then((config) => {
    if (typeof config.pollInterval === 'number') {
      adapter.pollInterval = config.pollInterval * 1000;
    }

    // Transition from old config format
    let modified = false;
    const urls = [];
    for (const entry of config.urls) {
      if (typeof entry === 'string') {
        urls.push({
          href: entry,
          authentication: {
            method: 'none',
          },
        });

        modified = true;
      } else {
        urls.push(entry);
      }
    }

    if (modified) {
      config.urls = urls;
      db.saveConfig(config);
    }

    for (const url of config.urls) {
      adapter.loadThing(url);
    }

    startDNSDiscovery(adapter);
  }).catch(console.error);
}

module.exports = loadThingURLAdapter;
