importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js')
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js')

firebase.initializeApp({
  apiKey:            'AIzaSyDFXU_DPLWWKOCYa_iAwrbc3Jw0Tv0Nr_g',
  authDomain:        'rapid-e8121.firebaseapp.com',
  projectId:         'rapid-e8121',
  storageBucket:     'rapid-e8121.firebasestorage.app',
  messagingSenderId: '206021897934',
  appId:             '1:206021897934:web:85ae8bcf256f67077a2a9f',
})

const messaging = firebase.messaging()

// Handle background notifications
messaging.onBackgroundMessage((payload) => {
  const { title, body } = payload.notification || {}
  self.registration.showNotification(title || 'RAPID Dispatch', {
    body:  body || 'New ambulance assignment',
    icon:  '/favicon.ico',
    badge: '/favicon.ico',
    tag:   'rapid-dispatch',
    requireInteraction: true,
  })
})
