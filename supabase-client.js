(function () {
  const fallbackConfig = {
    url: window.MEETMIND_SUPABASE_URL || '',
    publishableKey: window.MEETMIND_SUPABASE_PUBLISHABLE_KEY || '',
  };

  async function readConfig() {
    try {
      const apiUrl = window.MEETMIND_API_URL || ((window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') ? `${window.location.protocol}//${window.location.hostname}:8000` : 'https://lucent-hqi0.onrender.com');
      const response = await fetch(`${apiUrl}/api/config/supabase`, { cache: 'no-store' });
      if (!response.ok) {
        return fallbackConfig;
      }
      const config = await response.json();
      return {
        url: config.url || fallbackConfig.url,
        publishableKey: config.publishable_key || fallbackConfig.publishableKey,
      };
    } catch {
      return fallbackConfig;
    }
  }

  async function ensureClient() {
    if (window.meetmindSupabaseClient) return window.meetmindSupabaseClient;

    const config = await readConfig();
    if (!config.url || !config.publishableKey) {
      return null;
    }

    if (!window.supabase) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
        script.onload = resolve;
        script.onerror = () => reject(new Error('Failed to load Supabase client library'));
        document.head.appendChild(script);
      });
    }

    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      return null;
    }

    window.meetmindSupabaseClient = window.supabase.createClient(config.url, config.publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });

    return window.meetmindSupabaseClient;
  }

  window.meetmindSupabase = {
    ensureClient,
    readConfig,
  };
})();
