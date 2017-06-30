import * as log from 'loglevel';
import * as objectAssign from 'object-assign';

import SubscriptionHelper from '../../helpers/SubscriptionHelper';
import SdkEnvironment from '../../managers/SdkEnvironment';
import { ProxyFrameInitOptions } from '../../models/ProxyFrameInitOptions';
import { Uuid } from '../../models/Uuid';
import Postmam from '../../Postmam';

export default class RemoteFrame implements Disposable {
  protected messenger: Postmam;
  protected options: ProxyFrameInitOptions;

  // Promise to track whether connecting back to the host
  // page has finished
  private loadPromise: {
    promise: Promise<void>,
    resolver: Function,
    rejector: Function
  }

  constructor(initOptions: {
    /*
      These options are passed from the Rails app as plain raw untyped values.

      They have to be converted to the right types.
      */
    appId: string,
    /* Passed to both the iFrame and popup */
    subdomainName: string,
    /* Passed to both the iFrame and popup. Represents Site URL in dashboard config. */
    origin: string,
    /* These three flags may be deprecated */
    continuePressed: boolean,
    isPopup: boolean,
    isModal: boolean
  }) {
    this.options = {
      appId: new Uuid(initOptions.appId),
      subdomain: initOptions.subdomainName,
      origin: initOptions.origin
    };
  }

  /**
   * Loads the messenger on the iFrame to communicate with the host page and
   * assigns init options to an iFrame-only initialization of OneSignal.
   *
   * Our main host page will wait for all iFrame scripts to complete since the
   * host page uses the iFrame onload event to begin sending handshake messages
   * to the iFrame.
   *
   * There is no load timeout here; the iFrame initializes it scripts and waits
   * forever for the first handshake message.
   */
  initialize(): Promise<void> {
    const creator = window.opener || window.parent;
    if (creator == window) {
      document.write(`<span style='font-size: 14px; color: red; font-family: sans-serif;'>OneSignal: This page cannot be directly opened, and must be opened as a result of a subscription call.</span>`);
      return Promise.resolve();
    }

    // The rest of our SDK isn't refactored enough yet to accept typed objects
    // Within this class, we can use them, but when we assign them to
    // OneSignal.config, assign the simple string versions
    const rasterizedOptions = objectAssign(this.options);
    rasterizedOptions.appId = rasterizedOptions.appId.value;
    rasterizedOptions.origin = rasterizedOptions.origin;
    OneSignal.config = rasterizedOptions || {};
    OneSignal.initialized = true;

    (this as any).loadPromise = {};
    (this as any).loadPromise.promise = new Promise((resolve, reject) => {
        this.loadPromise.resolver = resolve;
        this.loadPromise.rejector = reject;
    });

    this.establishCrossOriginMessaging();
    return this.loadPromise.promise;
  }

  establishCrossOriginMessaging(): void {

  }

  dispose(): void {
    // Removes all events
    this.messenger.destroy();
  }

  protected finishInitialization() {
    this.loadPromise.resolver();
  }

  async subscribe() {
    // Do not register OneSignalSDKUpdaterWorker.js for HTTP popup sites; the file does not exist
    const isPushEnabled = await OneSignal.isPushNotificationsEnabled();
    if (!isPushEnabled) {
      try {
        await SubscriptionHelper.registerForPush();
      } catch (e) {
        log.error('Failed to register service worker in the popup/modal:', e);
      }
    } else {
      window.close();
    }
  }
}
