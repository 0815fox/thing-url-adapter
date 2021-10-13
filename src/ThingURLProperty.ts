class ThingURLProperty extends Property {
  constructor(device, name, url, propertyDescription) {
    super(device, name, propertyDescription);
    this.url = url;
    this.setCachedValue(propertyDescription.value);
    this.device.notifyPropertyChanged(this);
  }

  /**
   * @method setValue
   * @returns {Promise} resolves to the updated value
   *
   * @note it is possible that the updated value doesn't match
   * the value passed in.
   */
  setValue(value) {
    if (this.device.ws && this.device.ws.readyState === WebSocket.OPEN) {
      const msg = {
        messageType: SET_PROPERTY,
        data: {[this.name]: value},
      };

      this.device.ws.send(JSON.stringify(msg));

      // If the value is the same, we probably won't get a propertyStatus back
      // via the WebSocket, so let's go ahead and notify now.
      if (value === this.value) {
        this.device.notifyPropertyChanged(this);
      }

      return Promise.resolve(value);
    }

    return fetch(this.url, {
      method: 'PUT',
      headers: getHeaders(this.device.authentication, true),
      body: JSON.stringify({
        [this.name]: value,
      }),
    }).then((res) => {
      return res.json();
    }).then((response) => {
      const updatedValue = response[this.name];
      this.setCachedValue(updatedValue);
      this.device.notifyPropertyChanged(this);
      return updatedValue;
    }).catch((e) => {
      console.log(`Failed to set ${this.name}: ${e}`);
      return this.value;
    });
  }
}
