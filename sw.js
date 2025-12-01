// sw.js - Service Worker للتعامل مع الروابط المحمية
const CACHE_NAME = 'provoice-v1';
const PROTECTED_DOMAINS = [
    'hakunaymatata.com',
    'lok-lok',
    'bcdnxw'
];

// تثبيت الـ Service Worker
self.addEventListener('install', (event) => {
    console.log('Service Worker: Installing...');
    self.skipWaiting();
});

// تفعيل الـ Service Worker
self.addEventListener('activate', (event) => {
    console.log('Service Worker: Activated');
    event.waitUntil(self.clients.claim());
});

// اعتراض الطلبات
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    
    // تحقق إذا كان الرابط يحتاج معالجة خاصة
    const needsProxy = PROTECTED_DOMAINS.some(domain => url.hostname.includes(domain));
    
    if (needsProxy && event.request.method === 'GET') {
        event.respondWith(handleProtectedRequest(event.request));
    } else {
        // دع الطلب يمر بشكل طبيعي
        event.respondWith(fetch(event.request));
    }
});

// معالجة الطلبات المحمية
async function handleProtectedRequest(request) {
    try {
        // محاولة 1: طلب مباشر مع headers محددة
        const response = await fetch(request.url, {
            method: 'GET',
            mode: 'cors',
            credentials: 'omit',
            headers: {
                'Origin': 'https://lok-lok.cc',
                'Referer': 'https://lok-lok.cc/'
            },
            referrer: 'https://lok-lok.cc/',
            referrerPolicy: 'unsafe-url'
        });

        if (response.ok) {
            return response;
        }

        // محاولة 2: باستخدام no-cors mode
        const noCorsResponse = await fetch(request.url, {
            method: 'GET',
            mode: 'no-cors',
            credentials: 'omit',
            referrer: 'https://lok-lok.cc/',
            referrerPolicy: 'unsafe-url'
        });

        return noCorsResponse;

    } catch (error) {
        console.error('Service Worker: Fetch failed', error);
        
        // إرجاع استجابة خطأ
        return new Response('Failed to load protected resource', {
            status: 503,
            statusText: 'Service Unavailable'
        });
    }
}

// معالجة الرسائل من الصفحة الرئيسية
self.addEventListener('message', (event) => {
    if (event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});
