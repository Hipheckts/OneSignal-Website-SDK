import ActiveAnimatedElement from './ActiveAnimatedElement';


export default class Badge extends ActiveAnimatedElement {

  constructor() {
    super('.onesignal-bell-launcher-badge', 'onesignal-bell-launcher-badge-opened', null, 'onesignal-bell-launcher-badge-active', null, 'hidden');
  }

  increment() {
    // If it IS a number (is not not a number)
    if (!isNaN(this.content as any)) {
      let badgeNumber = +this.content; // Coerce to int
      badgeNumber += 1;
      this.content = badgeNumber.toString();
      return badgeNumber;
    }
  }

  decrement() {
    // If it IS a number (is not not a number)
    if (!isNaN(this.content as any)) {
      let badgeNumber = +this.content; // Coerce to int
      badgeNumber -= 1;
      if (badgeNumber > 0)
        this.content = badgeNumber.toString();
      else
        this.content = '';
      return badgeNumber;
    }
  }
}