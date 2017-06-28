import Postmam from '../../Postmam';
import RemoteFrame from './RemoteFrame';

/**
 * The actual OneSignal proxy frame contents / implementation, that is loaded
 * into the iFrame URL as subdomain.onesignal.com/webPushIFrame or
 * subdomain.os.tc/webPushIFrame. *
 */
export default class SubscriptionModal extends RemoteFrame {

  constructor(initOptions: any) {
    super(initOptions);
  }

  establishCrossOriginMessaging() {
    this.messenger = new Postmam(window.parent, this.options.origin, this.options.origin);
  }
}
