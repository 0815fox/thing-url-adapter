class ThingURLDevice extends Device {
  constructor(adapter, id, url, authentication, description, mdnsUrl) {
    super(adapter, id);
    this.title = this.name = description.title || description.name;
    this.type = description.type;
    this['@context'] =
      description['@context'] || 'https://iot.mozilla.org/schemas';
    this['@type'] = description['@type'] || [];
    this.url = url;
    this.authentication = authentication || {};
    this.mdnsUrl = mdnsUrl;
    this.actionsUrl = null;
    this.eventsUrl = null;
    this.wsUrl = null;
    this.description = description.description;
    this.propertyPromises = [];
    this.ws = null;
    this.wsBackoff = WS_INITIAL_BACKOFF;
    this.pingInterval = null;
    this.requestedActions = new Map();
    this.baseHref = new URL(url).origin;
    this.notifiedEvents = new Set();
    this.scheduledUpdate = null;
    this.closing = false;

    for (const actionName in description.actions) {
      const action = description.actions[actionName];
      if (action.hasOwnProperty('links')) {
        action.links = action.links.map((l) => {
          if (!l.href.startsWith('http://') && !l.href.startsWith('https://')) {
            l.proxy = true;
          }
          return l;
        });
      }
      this.addAction(actionName, action);
    }

    for (const eventName in description.events) {
      const event = description.events[eventName];
      if (event.hasOwnProperty('links')) {
        event.links = event.links.map((l) => {
          if (!l.href.startsWith('http://') && !l.href.startsWith('https://')) {
            l.proxy = true;
          }
          return l;
        });
      }
      this.addEvent(eventName, event);
    }

    for (const propertyName in description.properties) {
      const propertyDescription = description.properties[propertyName];

      let propertyUrl;
      if (propertyDescription.hasOwnProperty('links')) {
        for (const link of propertyDescription.links) {
          if (!link.rel || link.rel === 'property') {
            propertyUrl = this.baseHref + link.href;
            break;
          }
        }
      }

      if (!propertyUrl) {
        if (!propertyDescription.href) {
          continue;
        }

        propertyUrl = this.baseHref + propertyDescription.href;
      }

      this.propertyPromises.push(
        fetch(propertyUrl, {
          headers: getHeaders(this.authentication),
        }).then((res) => {
          return res.json();
        }).then((res) => {
          propertyDescription.value = res[propertyName];
          if (propertyDescription.hasOwnProperty('links')) {
            propertyDescription.links = propertyDescription.links.map((l) => {
              if (!l.href.startsWith('http://') &&
                  !l.href.startsWith('https://')) {
                l.proxy = true;
              }
              return l;
            });
          }
          const property = new ThingURLProperty(
            this, propertyName, propertyUrl, propertyDescription);
          this.properties.set(propertyName, property);
        }).catch((e) => {
          console.log(`Failed to connect to ${propertyUrl}: ${e}`);
        })
      );
    }

    // If a websocket endpoint exists, connect to it.
    if (description.hasOwnProperty('links')) {
      for (const link of description.links) {
        if (link.rel === 'actions') {
          this.actionsUrl = this.baseHref + link.href;
        } else if (link.rel === 'events') {
          this.eventsUrl = this.baseHref + link.href;
        } else if (link.rel === 'properties') {
          // pass
        } else if (link.rel === 'alternate') {
          if (link.mediaType === 'text/html') {
            if (!link.href.startsWith('http://') &&
                !link.href.startsWith('https://')) {
              link.proxy = true;
            }
            this.links.push(link);
          } else if (link.href.startsWith('ws://') ||
                     link.href.startsWith('wss://')) {
            this.wsUrl = link.href;
          } else {
            this.links.push(link);
          }
        } else {
          if (!link.href.startsWith('http://') &&
              !link.href.startsWith('https://')) {
            link.proxy = true;
          }
          this.links.push(link);
        }
      }
    }

    this.startReading();
  }

  startReading(now = false) {
    // If this is a recent gateway version, we hold off on polling/opening the
    // WebSocket until the user has actually saved the device.
    if (Adapter.prototype.hasOwnProperty('handleDeviceSaved') && !now) {
      return;
    }

    if (this.wsUrl) {
      if (!this.ws) {
        this.createWebSocket();
      }
    } else {
      // If there's no websocket endpoint, poll the device for updates.
      // eslint-disable-next-line no-lonely-if
      if (!this.scheduledUpdate) {
        Promise.all(this.propertyPromises).then(() => this.poll());
      }
    }
  }

  closeWebSocket() {
    this.closing = true;
    if (this.ws !== null) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }

      // Allow the cleanup code in createWebSocket to handle shutdown
    } else if (this.scheduledUpdate) {
      clearTimeout(this.scheduledUpdate);
    }
  }

  createWebSocket() {
    if (this.closing) {
      return;
    }

    let auth = '';
    switch (this.authentication.method) {
      case 'jwt':
        if (this.wsUrl.indexOf('?') >= 0) {
          auth = `&jwt=${this.authentication.token}`;
        } else {
          auth = `?jwt=${this.authentication.token}`;
        }
        break;
      case 'basic':
      case 'digest':
      default:
        // not implemented
        break;
    }

    this.ws = new WebSocket(`${this.wsUrl}${auth}`);

    this.ws.on('open', () => {
      this.connectedNotify(true);
      this.wsBackoff = WS_INITIAL_BACKOFF;

      if (this.events.size > 0) {
        // Subscribe to all events
        const msg = {
          messageType: ADD_EVENT_SUBSCRIPTION,
          data: {},
        };

        this.events.forEach((_value, key) => {
          msg.data[key] = {};
        });

        this.ws.send(JSON.stringify(msg));
      }

      this.pingInterval = setInterval(() => {
        this.ws.ping();
      }, PING_INTERVAL);
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);

        switch (msg.messageType) {
          case PROPERTY_STATUS: {
            for (const [name, value] of Object.entries(msg.data)) {
              const property = this.findProperty(name);
              if (property) {
                property.getValue().then((oldValue) => {
                  if (value !== oldValue) {
                    property.setCachedValue(value);
                    this.notifyPropertyChanged(property);
                  }
                });
              }
            }
            break;
          }
          case ACTION_STATUS: {
            for (const action of Object.values(msg.data)) {
              const requestedAction = this.requestedActions.get(action.href);
              if (requestedAction) {
                requestedAction.status = action.status;
                requestedAction.timeRequested = action.timeRequested;
                requestedAction.timeCompleted = action.timeCompleted;
                this.actionNotify(requestedAction);
              }
            }
            break;
          }
          case EVENT: {
            for (const [name, event] of Object.entries(msg.data)) {
              this.createEvent(name, event);
            }
            break;
          }
        }
      } catch (e) {
        console.log(`Error receiving websocket message: ${e}`);
      }
    });

    const cleanupAndReopen = () => {
      this.connectedNotify(false);

      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }

      this.ws.removeAllListeners('close');
      this.ws.removeAllListeners('error');
      this.ws.close();
      this.ws = null;

      setTimeout(() => {
        this.wsBackoff = Math.min(this.wsBackoff * 2, WS_MAX_BACKOFF);
        this.createWebSocket();
      }, this.wsBackoff);
    };

    this.ws.on('close', cleanupAndReopen);
    this.ws.on('error', cleanupAndReopen);
  }

  async poll() {
    if (this.closing) {
      return;
    }

    // Update properties
    await Promise.all(Array.from(this.properties.values()).map((prop) => {
      return fetch(prop.url, {
        headers: getHeaders(this.authentication),
      }).then((res) => {
        return res.json();
      }).then((res) => {
        const newValue = res[prop.name];
        prop.getValue().then((value) => {
          if (value !== newValue) {
            prop.setCachedValue(newValue);
            this.notifyPropertyChanged(prop);
          }
        });
      });
    })).then(() => {
      // Check for new actions
      if (this.actionsUrl !== null) {
        return fetch(this.actionsUrl, {
          headers: getHeaders(this.authentication),
        }).then((res) => {
          return res.json();
        }).then((actions) => {
          for (let action of actions) {
            const actionName = Object.keys(action)[0];
            action = action[actionName];
            const requestedAction =
              this.requestedActions.get(action.href);

            if (requestedAction && action.status !== requestedAction.status) {
              requestedAction.status = action.status;
              requestedAction.timeRequested = action.timeRequested;
              requestedAction.timeCompleted = action.timeCompleted;
              this.actionNotify(requestedAction);
            }
          }
        });
      }

      return Promise.resolve();
    }).then(() => {
      // Check for new events
      if (this.eventsUrl !== null) {
        return fetch(this.eventsUrl, {
          headers: getHeaders(this.authentication),
        }).then((res) => {
          return res.json();
        }).then((events) => {
          for (let event of events) {
            const eventName = Object.keys(event)[0];
            event = event[eventName];
            this.createEvent(eventName, event);
          }
        });
      }

      return Promise.resolve();
    }).then(() => {
      this.connectedNotify(true);
      return Promise.resolve();
    }).catch((e) => {
      console.log(`Failed to poll device: ${e}`);
      this.connectedNotify(false);
    });

    if (this.scheduledUpdate) {
      clearTimeout(this.scheduledUpdate);
    }

    this.scheduledUpdate = setTimeout(
      () => this.poll(),
      this.adapter.pollInterval
    );
  }

  createEvent(eventName, event) {
    const eventId = (event.data && event.data.hasOwnProperty('id')) ?
      event.data.id :
      `${eventName}-${event.timestamp}`;

    if (this.notifiedEvents.has(eventId)) {
      return;
    }
    if (!event.hasOwnProperty('timestamp')) {
      event.timestamp = new Date().toISOString();
    }
    this.notifiedEvents.add(eventId);
    const e = new Event(this,
                        eventName,
                        event.data || null);
    e.timestamp = event.timestamp;

    this.eventNotify(e);
  }

  performAction(action) {
    action.start();
    return fetch(this.actionsUrl, {
      method: 'POST',
      headers: getHeaders(this.authentication, true),
      body: JSON.stringify({[action.name]: {input: action.input}}),
    }).then((res) => {
      return res.json();
    }).then((res) => {
      this.requestedActions.set(res[action.name].href, action);
    }).catch((e) => {
      console.log(`Failed to perform action: ${e}`);
      action.status = 'error';
      this.actionNotify(action);
    });
  }

  cancelAction(actionId, actionName) {
    let promise;

    this.requestedActions.forEach((action, actionHref) => {
      if (action.name === actionName && action.id === actionId) {
        promise = fetch(actionHref, {
          method: 'DELETE',
          headers: getHeaders(this.authentication),
        }).catch((e) => {
          console.log(`Failed to cancel action: ${e}`);
        });

        this.requestedActions.delete(actionHref);
      }
    });

    if (!promise) {
      promise = Promise.resolve();
    }

    return promise;
  }
}
