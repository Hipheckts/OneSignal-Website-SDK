import Environment from "../Environment";
import * as log from "loglevel";
import Event from "../Event";
import Database from "../services/Database";
import * as Browser from "bowser";
import {getConsoleStyle, contains, timeoutPromise} from "../utils";
import MainHelper from "./MainHelper";
import ServiceWorkerHelper from "./ServiceWorkerHelper";
import EventHelper from "./EventHelper";
import PushPermissionNotGrantedError from "../errors/PushPermissionNotGrantedError";
import TestHelper from "./TestHelper";
import SdkEnvironment from '../managers/SdkEnvironment';
import { WindowEnvironmentKind } from '../models/WindowEnvironmentKind';
import TimeoutError from '../errors/TimeoutError';


export default class SubscriptionHelper {
  /*
   * Checks whether we should continue.
   * Register correct kind of service worker.
   */
  static registerForW3CPush(options) {
    log.debug(`Called %cregisterForW3CPush(${JSON.stringify(options)})`, getConsoleStyle('code'));
    return Database.get('Ids', 'registrationId')
      .then(function _registerForW3CPush_GotRegistrationId(registrationIdResult) {
                     /*
                        If there's:
                          - No saved push token
                          - Or this method was called internally
                          - Or notification permissions are unprompted or blocked
                          - Or there's no active service worker
                      */
                     if (!registrationIdResult || !options.fromRegisterFor || window.Notification.permission != "granted" || navigator.serviceWorker.controller == null) {
                       navigator.serviceWorker.getRegistration().then(function (serviceWorkerRegistration) {
                         var sw_path = "";

                         // Obtain directory path to SW file
                         if (OneSignal.config.path)
                           sw_path = OneSignal.config.path;

                        /*
                          Are there any existing registrations?

                          Based on on which SW was installed last, install the normal or alternate worker.
                          If no SW was installed, install the normal worker.
                          If we detect a non-OneSignal worker, overwrite it. But unregister for push first.

                          After the registerServiceWorker() call is enableNotifications
                         */
                         if (typeof serviceWorkerRegistration === "undefined") // Nothing registered, very first run
                           ServiceWorkerHelper.registerServiceWorker(sw_path + SdkEnvironment.getBuildEnvPrefix() + OneSignal.SERVICE_WORKER_PATH);
                         else {
                           if (serviceWorkerRegistration.active) {
                             let previousWorkerUrl = serviceWorkerRegistration.active.scriptURL;
                             if (contains(previousWorkerUrl, sw_path + SdkEnvironment.getBuildEnvPrefix() + OneSignal.SERVICE_WORKER_PATH)) {
                               // OneSignalSDKWorker.js was installed
                               Database.get('Ids', 'WORKER1_ONE_SIGNAL_SW_VERSION')
                                       .then(function (version) {
                                         if (version) {
                                           if (version != OneSignal._VERSION) {
                                             log.info(`Installing new service worker (${version} -> ${OneSignal._VERSION})`);
                                             ServiceWorkerHelper.registerServiceWorker(sw_path + SdkEnvironment.getBuildEnvPrefix() + OneSignal.SERVICE_WORKER_UPDATER_PATH);
                                           }
                                           else
                                             ServiceWorkerHelper.registerServiceWorker(sw_path + SdkEnvironment.getBuildEnvPrefix() + OneSignal.SERVICE_WORKER_PATH);
                                         }
                                         else
                                           ServiceWorkerHelper.registerServiceWorker(sw_path + SdkEnvironment.getBuildEnvPrefix() + OneSignal.SERVICE_WORKER_UPDATER_PATH);
                                       });
                             }
                             else if (contains(previousWorkerUrl, sw_path + SdkEnvironment.getBuildEnvPrefix() + OneSignal.SERVICE_WORKER_UPDATER_PATH)) {
                               // OneSignalSDKUpdaterWorker.js was installed
                               Database.get('Ids', 'WORKER2_ONE_SIGNAL_SW_VERSION')
                                       .then(function (version) {
                                         if (version) {
                                           if (version != OneSignal._VERSION) {
                                             log.info(`Installing new service worker (${version} -> ${OneSignal._VERSION})`);
                                             ServiceWorkerHelper.registerServiceWorker(sw_path + SdkEnvironment.getBuildEnvPrefix() + OneSignal.SERVICE_WORKER_PATH);
                                           }
                                           else
                                             ServiceWorkerHelper.registerServiceWorker(sw_path + SdkEnvironment.getBuildEnvPrefix() + OneSignal.SERVICE_WORKER_UPDATER_PATH);
                                         }
                                         else
                                           ServiceWorkerHelper.registerServiceWorker(sw_path + SdkEnvironment.getBuildEnvPrefix() + OneSignal.SERVICE_WORKER_PATH);
                                       });
                             } else {
                               // Some other service worker not belonging to us was installed
                               // Install ours over it after unregistering theirs to get a different registration token and avoid mismatchsenderid error
                               log.info('Unregistering previous service worker:', serviceWorkerRegistration);
                               serviceWorkerRegistration.unregister().then(unregistrationSuccessful => {
                                 log.info('Result of unregistering:', unregistrationSuccessful);
                                 ServiceWorkerHelper.registerServiceWorker(sw_path + SdkEnvironment.getBuildEnvPrefix() + OneSignal.SERVICE_WORKER_PATH);
                               });
                             }
                           }
                           else if (serviceWorkerRegistration.installing == null)
                             ServiceWorkerHelper.registerServiceWorker(sw_path + SdkEnvironment.getBuildEnvPrefix() + OneSignal.SERVICE_WORKER_PATH);
                         }
                       });
                     }
                   });
  }

  /*
   * Waits until service worker is ready.
   * Opens messagePort to listen to SW messages.
   */
  static enableNotifications(existingServiceWorkerRegistration) { // is ServiceWorkerRegistration type
    log.debug(`Called %cenableNotifications()`, getConsoleStyle('code'));
    // TODO: This should be removed because it's deprecated
    // Start session if push is not supported? Is this necessary?
    if (!('PushManager' in window)) {
      log.info("Push messaging is not supported. No PushManager.");
      MainHelper.beginTemporaryBrowserSession();
      return;
    }

    // Return if notifications are blocked
    if (window.Notification.permission === 'denied') {
      log.warn("The user has blocked notifications.");
      return;
    }

    // Waits until the installed service worker is ready
    log.debug(`Calling %cnavigator.serviceWorker.ready() ...`, getConsoleStyle('code'));
    navigator.serviceWorker.ready.then(function (serviceWorkerRegistration) {
      log.debug('Finished calling %cnavigator.serviceWorker.ready', getConsoleStyle('code'));
      // Installs message channel to receive service worker messages
      MainHelper.establishServiceWorkerChannel(serviceWorkerRegistration);
      // Runs this
      SubscriptionHelper.subscribeForPush(serviceWorkerRegistration);
    });
  }

  /**
   * Returns true if web push subscription occurs on a subdomain of OneSignal.
   * If true, our main IndexedDB is stored on the subdomain of onesignal.com, and not the user's site.
   * @remarks
   *   This method returns true if:
   *     - The browser is not Safari
   *         - Safari uses a different method of subscription and does not require our workaround
   *     - The init parameters contain a subdomain (even if the protocol is HTTPS)
   *         - HTTPS users using our subdomain workaround still have the main IndexedDB stored on our subdomain
   *        - The protocol of the current webpage is http:
   *   Exceptions are:
   *     - Safe hostnames like localhost and 127.0.0.1
   *          - Because we don't want users to get the wrong idea when testing on localhost that direct permission is supported on HTTP, we'll ignore these exceptions. HTTPS will always be required for direct permission
   *        - We are already in popup or iFrame mode, or this is called from the service worker
   */
  static isUsingSubscriptionWorkaround() {
    if (!OneSignal.config) {
      throw new Error(`(${SdkEnvironment.getWindowEnv().toString()}) isUsingSubscriptionWorkaround() cannot be called until OneSignal.config exists.`);
    }
    if (Browser.safari) {
      return false;
    }

    if (SubscriptionHelper.isLocalhostAllowedAsSecureOrigin() &&
      location.hostname === 'localhost' ||
      (location.hostname as any) === '127.0.0.1') {
      return false;
    }

    return ((SdkEnvironment.getWindowEnv() === WindowEnvironmentKind.Host) &&
    (!!OneSignal.config.subdomainName || location.protocol === 'http:'));
  }

  /**
   * Returns true if the current frame context is a child iFrame, and the parent is not HTTPS.
   *
   * This is used to check if isPushNotificationsEnabled() should grab the service worker registration. In an HTTPS iframe of an HTTP page,
   * getting the service worker registration would throw an error.
   */
  static async hasInsecureParentOrigin() {
    // If we are the top frame, or service workers aren't available, don't run this check
    if (window === window.top ||
      !('serviceWorker' in navigator) ||
      typeof navigator.serviceWorker.getRegistration === "undefined") {
      return false;
    }
    try {
      await navigator.serviceWorker.getRegistration();
      return false;
    } catch (e) {
      return true;
    }
  }

  static isLocalhostAllowedAsSecureOrigin() {
    return OneSignal.config && OneSignal.config.allowLocalhostAsSecureOrigin === true;
  }

  /*
   * Subscribe, get info, and
   */
  static subscribeForPush(serviceWorkerRegistration) {
    log.debug(`Called %c_subscribeForPush()`, getConsoleStyle('code'));
    var notificationPermissionBeforeRequest = '';

    /*
      Obtain existing notification permission before we actually prompt the user.
      Not needed anymore since Chrome 52.
     */
    OneSignal.getNotificationPermission().then((permission) => {
      notificationPermissionBeforeRequest = permission as any;
    })
             .then(() => {
               log.debug(`Calling %cServiceWorkerRegistration.pushManager.subscribe()`, getConsoleStyle('code'));
               /*
                  Trigger the permissionPromptDisplay event to the best of our knowledge.
                */
               Event.trigger(OneSignal.EVENTS.PERMISSION_PROMPT_DISPLAYED);
               /*
                7/29/16: If the user dismisses the prompt, the prompt cannot be shown again via pushManager.subscribe()
                See: https://bugs.chromium.org/p/chromium/issues/detail?id=621461
                Our solution is to call Notification.requestPermission(), and then call
                pushManager.subscribe(). Because notification and push permissions are shared, the subesequent call to
                pushManager.subscribe() will go through successfully.

                6/14/17: I don't think this is necessary anymore. There's been 7 Chrome versions since the bug has been fixed.
                */
               return MainHelper.requestNotificationPermissionPromise();
             })
             .then(permission => {
               if (permission !== "granted") {
                 /*
                    The user either dismissed or blocked the permission. Exit control flow to the .catch() block.
                    We don't want to throw exceptions to modify the program flow, so fix this in the rewrite.
                  */
                 throw new PushPermissionNotGrantedError();
               } else {
                 /*
                    Permissions were granted. Subscribe on a 15-second timeout.
                  */
                 return timeoutPromise(
                   serviceWorkerRegistration.pushManager.subscribe({userVisibleOnly: true}),
                   15000
                 );
               }
             })
             .then(function (subscription: any) {
               log.debug(`Finished calling %cServiceWorkerRegistration.pushManager.subscribe()`,
                         getConsoleStyle('code'));
               log.debug('Subscription details:', subscription);
               /*
                  Permissions were either just granted or already previously granted,
                  Set the flag that we're showing the prompt to false.
                */
               OneSignal._sessionInitAlreadyRunning = false;
               /*
                  Set in sessionStorage that the notification permission is granted.
                */
               sessionStorage.setItem("ONE_SIGNAL_NOTIFICATION_PERMISSION", window.Notification.permission);

               MainHelper.getAppId()
                         .then(appId => {
                           log.debug("Finished subscribing for push via pushManager.subscribe().");

                           /*
                              Grab some info to package and bundle to send to OneSignal registration API.
                            */
                           var subscriptionInfo: any = {};
                           if (subscription) {
                             if (typeof (subscription).subscriptionId != "undefined") {
                               // Chrome 43 & 42
                               subscriptionInfo.endpointOrToken = subscription.subscriptionId;
                             }
                             else {
                               // Chrome 44+ and FireFox
                               // 4/13/16: We now store the full endpoint instead of just the registration token
                               subscriptionInfo.endpointOrToken = subscription.endpoint;
                             }

                             // 4/13/16: Retrieve p256dh and auth for new encrypted web push protocol in Chrome 50
                             if (subscription.getKey) {
                               // p256dh and auth are both ArrayBuffer
                               let p256dh = null;
                               try {
                                 p256dh = subscription.getKey('p256dh');
                               } catch (e) {
                                 // User is most likely running < Chrome < 50
                               }
                               let auth = null;
                               try {
                                 auth = subscription.getKey('auth');
                               } catch (e) {
                                 // User is most likely running < Firefox 45
                               }

                               if (p256dh) {
                                 // Base64 encode the ArrayBuffer (not URL-Safe, using standard Base64)
                                 let p256dh_base64encoded = btoa(
                                   String.fromCharCode.apply(null, new Uint8Array(p256dh)));
                                 subscriptionInfo.p256dh = p256dh_base64encoded;
                               }
                               if (auth) {
                                 // Base64 encode the ArrayBuffer (not URL-Safe, using standard Base64)
                                 let auth_base64encoded = btoa(
                                   String.fromCharCode.apply(null, new Uint8Array(auth)));
                                 subscriptionInfo.auth = auth_base64encoded;
                               }
                             }
                           }
                           else
                             log.warn('Could not subscribe your browser for push notifications.');

                           /*
                              If we're inside the HTTP popup, close the popup to allow the iFrame to finish subscribing.
                            */
                           if (SdkEnvironment.getWindowEnv() === WindowEnvironmentKind.OneSignalSubscriptionPopup) {
                             // 12/16/2015 -- At this point, the user has just clicked Allow on the HTTP popup!!
                             // 11/22/2016 - HTTP popup should move non-essential subscription parts to the iframe
                             OneSignal.subscriptionPopup.message(OneSignal.POSTMAM_COMMANDS.FINISH_REMOTE_REGISTRATION, {
                               subscriptionInfo: subscriptionInfo
                             }, message => {
                               if (message.data.progress === true) {
                                 log.debug('Got message from host page that remote reg. is in progress, closing popup.');
                                 var creator = opener || parent;
                                 if (opener) {
                                   /* Note: This is hard to find, but this is actually the code that closes the HTTP popup window */
                                   window.close();
                                 }
                               } else {
                                 log.debug('Got message from host page that remote reg. could not be finished.');
                               }
                             });
                           } else {
                             /*
                                Otherwise if we're on an HTTPS site, just finish the registration.
                              */
                             MainHelper.registerWithOneSignal(appId, subscriptionInfo);
                           }
                         });
             })
      .catch(function (e) {
               /*
                  Any one of a number of native subscription errors occurred, or the user blocked or dismissed the notification prompt (catches error we throw).
                */
               OneSignal._sessionInitAlreadyRunning = false;
               if (e instanceof TimeoutError) {
                 /*
                  * The subscription timed out after 15 seconds (TODO: this should only be enforced on the popup, but should be tripled on HTTPS sites)
                  */
                 log.error("A possible Chrome bug (https://bugs.chromium.org/p/chromium/issues/detail?id=623062) is preventing this subscription from completing.");
               }
               /*
                  GCM Sender ID manifest.json issues
                */
               if (e.message === 'Registration failed - no sender id provided' || e.message === 'Registration failed - manifest empty or missing') {
                 let manifestDom = document.querySelector('link[rel=manifest]');
                 if (manifestDom) {
                   let manifestParentTagname = (document as any).querySelector('link[rel=manifest]').parentNode.tagName.toLowerCase();
                   let manifestHtml = (document as any).querySelector('link[rel=manifest]').outerHTML;
                   let manifestLocation = (document as any).querySelector('link[rel=manifest]').href;
                   if (manifestParentTagname !== 'head') {
                     log.warn(`OneSignal: Your manifest %c${manifestHtml}`,
                              getConsoleStyle('code'),
                              'must be referenced in the <head> tag to be detected properly. It is currently referenced ' +
                              'in <${manifestParentTagname}>. Please see step 3.1 at ' +
                              'https://documentation.onesignal.com/docs/web-push-sdk-setup-https.');
                   } else {
                     let manifestLocationOrigin = new URL(manifestLocation).origin;
                     let currentOrigin = location.origin;
                     if (currentOrigin !== manifestLocationOrigin) {
                       log.warn(`OneSignal: Your manifest is being served from ${manifestLocationOrigin}, which is ` +
                                `different from the current page's origin of ${currentOrigin}. Please serve your ` +
                                `manifest from the same origin as your page's. If you are using a content delivery ` +
                                `network (CDN), please add an exception so that the manifest is not served by your CDN. ` +
                                `WordPress users, please see ` +
                                `https://documentation.onesignal.com/docs/troubleshooting-web-push#section-wordpress-cdn-support.`);
                     } else {
                       log.warn(`OneSignal: Please check your manifest at ${manifestLocation}. The %cgcm_sender_id`,
                                getConsoleStyle('code'),
                                "field is missing or invalid, and a valid value is required. Please see step 2 at " +
                                "https://documentation.onesignal.com/docs/web-push-sdk-setup-https.");
                     }
                   }
                 } else if (location.protocol === 'https:') {
                   log.warn(`OneSignal: You must reference a %cmanifest.json`,
                            getConsoleStyle('code'),
                            "in the <head> of your page. Please see step 2 at " +
                            "https://documentation.onesignal.com/docs/web-push-sdk-setup-https.");
                 }
               } else if (e instanceof PushPermissionNotGrantedError) {
                 /*
                    User blocked or dismissed the notification permission prompt.
                  */
               } else {
                 /*
                    Any other error.
                  */
                 log.error('Error while subscribing for push:', e);
               }

               // In Chrome, closing a tab while the prompt is displayed is the same as dismissing the prompt by clicking X
               // Our SDK receives the same event as if the user clicked X, when in fact the user just closed the tab. If
               // we had some code that prevented showing the prompt for 8 hours, the user would accidentally not be able
               // to subscribe.

               // New addition (12/22/2015), adding support for detecting the cancel 'X'
               // Chrome doesn't show when the user clicked 'X' for cancel
               // We get the same error as if the user had clicked denied, but we can check Notification.permission to see if it is still 'default'
               OneSignal.getNotificationPermission().then((permission) => {
                 if (permission as any === 'default') {
                   // The user clicked 'X'
                   EventHelper.triggerNotificationPermissionChanged(true);
                   TestHelper.markHttpsNativePromptDismissed();
                 }

                 if (!OneSignal._usingNativePermissionHook)
                   EventHelper.triggerNotificationPermissionChanged();

                 if (opener && SdkEnvironment.getWindowEnv() === WindowEnvironmentKind.OneSignalSubscriptionPopup)
                   window.close();
               });

               // If there was an error subscribing like the timeout bug, close the popup anyways
               if (opener && SdkEnvironment.getWindowEnv() === WindowEnvironmentKind.OneSignalSubscriptionPopup)
                 window.close();
             });
  }
}
