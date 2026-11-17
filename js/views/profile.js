// The profile now lives in the Account window (js/account.js). Old #/profile links open it over the home page.
import { openAccount } from '../account.js';

export function render() {
  openAccount();
  location.replace('#/');
  return () => {};
}
