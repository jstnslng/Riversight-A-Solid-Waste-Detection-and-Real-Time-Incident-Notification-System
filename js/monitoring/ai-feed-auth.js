import { auth } from '../shared/firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

// ID tokens remain in memory and travel only in HTTPS Authorization headers.
window.riversightAIIdToken = async () => {
  await auth.authStateReady();
  if (!auth.currentUser) throw new Error('Sign-in required');
  return auth.currentUser.getIdToken();
};
onAuthStateChanged(auth, () => document.dispatchEvent(new Event('riversight:ai-auth-changed')));
