// api.js — API client with Bearer token auth and connection tracking

class ApiClient {
  constructor() {
    this.token = localStorage.getItem('favor_token') || '';
    this.base = window.location.origin;
    this._connected = false;
    this._listeners = new Set();
  }

  setToken(t) { this.token = t; localStorage.setItem('favor_token', t); }
  clearToken() { this.token = ''; localStorage.removeItem('favor_token'); }
  hasToken() { return !!this.token; }
  get connected() { return this._connected; }

  onConnectionChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  _setConnected(v) {
    if (this._connected !== v) { this._connected = v; this._listeners.forEach(fn => fn(v)); }
  }

  async _fetch(path, opts = {}) {
    try {
      const res = await fetch(this.base + path, {
        ...opts,
        headers: { 'Authorization': 'Bearer ' + this.token, ...opts.headers }
      });
      if (res.status === 401) {
        this.clearToken(); window.dispatchEvent(new Event('auth:logout'));
        this._setConnected(false); return null;
      }
      if (!res.ok) { this._setConnected(true); return null; }
      this._setConnected(true);
      return res.json();
    } catch { this._setConnected(false); return null; }
  }

  get(path) { return this._fetch(path); }

  post(path, body) {
    return this._fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
  }
}

export const api = new ApiClient();
