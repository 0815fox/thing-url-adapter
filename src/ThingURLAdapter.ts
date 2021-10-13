import { Adapter, AddonManagerProxy } from "gateway-addon";

class ThingURLAdapter extends Adapter {
  constructor(addonManager: AddonManagerProxy) {
    const manifest = require('./manifest.json');
    super(addonManager, manifest.id, manifest.id);
    addonManager.addAdapter(this);
    this.knownUrls = {};
    this.savedDevices = new Set();
    this.pollInterval = POLL_INTERVAL;
  }

  async loadThing(url, retryCounter) {
    if (typeof retryCounter === 'undefined') {
      retryCounter = 0;
    }

    const href = url.href.replace(/\/$/, '');

    if (!this.knownUrls[href]) {
      this.knownUrls[href] = {
        href,
        authentication: url.authentication,
        digest: '',
        timestamp: 0,
      };
    }

    if (this.knownUrls[href].timestamp + 5000 > Date.now()) {
      return;
    }

    let res;
    try {
      res = await fetch(href, {headers: getHeaders(url.authentication)});
    } catch (e) {
      // Retry the connection at a 2 second interval up to 5 times.
      if (retryCounter >= 5) {
        console.log(`Failed to connect to ${href}: ${e}`);
      } else {
        setTimeout(() => this.loadThing(url, retryCounter + 1), 2000);
      }

      return;
    }

    const text = await res.text();

    const hash = crypto.createHash('md5');
    hash.update(text);
    const dig = hash.digest('hex');
    let known = false;
    if (this.knownUrls[href].digest === dig) {
      known = true;
    }

    this.knownUrls[href] = {
      href,
      authentication: url.authentication,
      digest: dig,
      timestamp: Date.now(),
    };

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.log(`Failed to parse description at ${href}: ${e}`);
      return;
    }

    let things;
    if (Array.isArray(data)) {
      things = data;
    } else {
      things = [data];
    }

    for (const thingDescription of things) {
      let thingUrl = href;
      if (thingDescription.hasOwnProperty('href')) {
        const baseHref = new URL(href).origin;
        thingUrl = baseHref + thingDescription.href;
      }

      const id = thingUrl.replace(/[:/]/g, '-');
      if (id in this.devices) {
        if (known) {
          continue;
        }
        await this.removeThing(this.devices[id], true);
      }

      await this.addDevice(
        id,
        thingUrl,
        url.authentication,
        thingDescription,
        href
      );
    }
  }

  unloadThing(url) {
    url = url.replace(/\/$/, '');

    for (const id in this.devices) {
      const device = this.devices[id];
      if (device.mdnsUrl === url) {
        device.closeWebSocket();
        this.removeThing(device, true);
      }
    }

    if (this.knownUrls[url]) {
      delete this.knownUrls[url];
    }
  }

  /**
   * Add a ThingURLDevice to the ThingURLAdapter
   *
   * @param {String} deviceId ID of the device to add.
   * @return {Promise} which resolves to the device added.
   */
  addDevice(deviceId, deviceURL, authentication, description, mdnsUrl) {
    return new Promise((resolve, reject) => {
      if (deviceId in this.devices) {
        reject(`Device: ${deviceId} already exists.`);
      } else {
        const device = new ThingURLDevice(
          this,
          deviceId,
          deviceURL,
          authentication,
          description,
          mdnsUrl
        );
        Promise.all(device.propertyPromises).then(() => {
          this.handleDeviceAdded(device);

          if (this.savedDevices.has(deviceId)) {
            device.startReading(true);
          }

          resolve(device);
        }).catch((e) => reject(e));
      }
    });
  }

  /**
   * Handle a user saving a device. Note that incoming devices may not be for
   * this adapter.
   *
   * @param {string} deviceId - ID of the device
   */
  handleDeviceSaved(deviceId) {
    this.savedDevices.add(deviceId);

    if (this.devices.hasOwnProperty(deviceId)) {
      this.devices[deviceId].startReading(true);
    }
  }

  /**
   * Remove a ThingURLDevice from the ThingURLAdapter.
   *
   * @param {Object} device The device to remove.
   * @param {boolean} internal Whether or not this is being called internally
   * @return {Promise} which resolves to the device removed.
   */
  removeThing(device, internal) {
    return this.removeDeviceFromConfig(device).then(() => {
      if (!internal) {
        this.savedDevices.delete(device.id);
      }

      if (this.devices.hasOwnProperty(device.id)) {
        this.handleDeviceRemoved(device);
        device.closeWebSocket();
        return device;
      } else {
        throw new Error(`Device: ${device.id} not found.`);
      }
    });
  }

  /**
   * Remove a device's URL from this adapter's config if it was manually added.
   *
   * @param {Object} device The device to remove.
   */
  async removeDeviceFromConfig(device) {
    try {
      const db = new Database(this.packageName);
      await db.open();
      const config = await db.loadConfig();

      // If the device's URL is saved in the config, remove it.
      const urlIndex = config.urls.indexOf(device.url);
      if (urlIndex >= 0) {
        config.urls.splice(urlIndex, 1);
        await db.saveConfig(config);

        // Remove from list of known URLs as well.
        const adjustedUrl = device.url.replace(/\/$/, '');
        if (this.knownUrls.hasOwnProperty(adjustedUrl)) {
          delete this.knownUrls[adjustedUrl];
        }
      }
    } catch (err) {
      console.error(`Failed to remove device ${device.id} from config: ${err}`);
    }
  }

  startPairing() {
    for (const knownUrl of Object.values(this.knownUrls)) {
      this.loadThing(knownUrl).catch((err) => {
        console.warn(`Unable to reload Thing(s) from ${knownUrl}: ${err}`);
      });
    }
  }

  unload() {
    if (webthingBrowser) {
      webthingBrowser.stop();
    }

    if (subtypeBrowser) {
      subtypeBrowser.stop();
    }

    if (httpBrowser) {
      httpBrowser.stop();
    }

    for (const id in this.devices) {
      this.devices[id].closeWebSocket();
    }

    return super.unload();
  }
}

function startDNSDiscovery(adapter) {
  console.log('Starting mDNS discovery');

  webthingBrowser =
    new dnssd.Browser(new dnssd.ServiceType('_webthing._tcp'));
  webthingBrowser.on('serviceUp', (service) => {
    const host = service.host.replace(/\.$/, '');
    let protocol = 'http';
    if (service.txt.hasOwnProperty('tls') && service.txt.tls === '1') {
      protocol = 'https';
    }
    adapter.loadThing({
      href: `${protocol}://${host}:${service.port}${service.txt.path}`,
      authentication: {
        method: 'none',
      },
    });
  });
  webthingBrowser.on('serviceDown', (service) => {
    const host = service.host.replace(/\.$/, '');
    let protocol = 'http';
    if (service.txt.hasOwnProperty('tls') && service.txt.tls === '1') {
      protocol = 'https';
    }
    adapter.unloadThing(
      `${protocol}://${host}:${service.port}${service.txt.path}`
    );
  });
  webthingBrowser.start();

  // Support legacy devices
  subtypeBrowser =
    new dnssd.Browser(new dnssd.ServiceType('_http._tcp,_webthing'));
  subtypeBrowser.on('serviceUp', (service) => {
    adapter.loadThing({
      href: service.txt.url,
      authentication: {
        method: 'none',
      },
    });
  });
  subtypeBrowser.on('serviceDown', (service) => {
    adapter.unloadThing(service.txt.url);
  });
  subtypeBrowser.start();

  httpBrowser = new dnssd.Browser(new dnssd.ServiceType('_http._tcp'));
  httpBrowser.on('serviceUp', (service) => {
    if (typeof service.txt === 'object' &&
        service.txt.hasOwnProperty('webthing')) {
      adapter.loadThing({
        href: service.txt.url,
        authentication: {
          method: 'none',
        },
      });
    }
  });
  httpBrowser.on('serviceDown', (service) => {
    if (typeof service.txt === 'object' &&
        service.txt.hasOwnProperty('webthing')) {
      adapter.unloadThing(service.txt.url);
    }
  });
  httpBrowser.start();
}
