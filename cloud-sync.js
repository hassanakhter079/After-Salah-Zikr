/**
 * Universal GitHub Cloud Sync for Static Web Apps
 * Syncs app data across phone, tablet, and PC via GitHub Gist.
 * Shared across all apps hosted on https://hassanakhter079.github.io/
 */
(function (global) {
  'use strict';

  var DEFAULT_GIST_ID = '41efe86cf4a73c55bea714b8213044fd';
  var TOKEN_KEY = 'cloud_sync_token';
  var GIST_ID_KEY = 'cloud_sync_gist_id';
  var LAST_SYNC_KEY = 'cloud_sync_last_time';

  // Determine App ID from script tag data-app attribute or fallback
  var currentScript = document.currentScript || (function () {
    var scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  })();
  var defaultAppId = (currentScript && currentScript.getAttribute('data-app')) ||
    location.pathname.replace(/^\/|\/$/g, '').split('/')[0] || 'app';

  var CloudSync = {
    appId: defaultAppId,
    gistId: localStorage.getItem(GIST_ID_KEY) || DEFAULT_GIST_ID,
    token: localStorage.getItem(TOKEN_KEY) || '',
    status: 'idle', // 'idle' | 'syncing' | 'synced' | 'error' | 'disconnected'
    lastSyncTime: localStorage.getItem(LAST_SYNC_KEY) || null,
    debounceTimer: null,
    onPullCallback: null,
    getPayloadCallback: null,
    autoLocalStorage: true,

    init: function (options) {
      options = options || {};
      if (options.appId) this.appId = options.appId;
      if (options.onPull) this.onPullCallback = options.onPull;
      if (options.getPayload) this.getPayloadCallback = options.getPayload;
      if (typeof options.autoLocalStorage === 'boolean') this.autoLocalStorage = options.autoLocalStorage;

      // Check URL hash for token setup (e.g. #sync_token=ghp_xxx)
      this._checkUrlHash();

      // Ensure Gist ID is saved
      if (!localStorage.getItem(GIST_ID_KEY)) {
        localStorage.setItem(GIST_ID_KEY, this.gistId);
      }

      // Inject UI styles and badge
      this._injectStyles();
      this._createBadge();
      this._createModal();

      // Hook localStorage if auto sync is enabled
      if (this.autoLocalStorage) {
        this._hookLocalStorage();
      }

      // Initial sync if token is available
      if (this.token) {
        this.pull();
      } else {
        this._updateBadge('disconnected', 'Connect Sync');
      }

      return this;
    },

    _checkUrlHash: function () {
      var hash = window.location.hash;
      if (hash && hash.indexOf('sync_token=') !== -1) {
        var match = hash.match(/sync_token=([^&]+)/);
        if (match && match[1]) {
          var token = decodeURIComponent(match[1]);
          this.setToken(token);
          // Remove token from URL hash without reload
          if (window.history && window.history.replaceState) {
            var cleanUrl = window.location.pathname + window.location.search;
            window.history.replaceState(null, '', cleanUrl);
          }
        }
      }
    },

    setToken: function (token) {
      this.token = (token || '').trim();
      if (this.token) {
        localStorage.setItem(TOKEN_KEY, this.token);
      } else {
        localStorage.removeItem(TOKEN_KEY);
      }
      this._updateModalView();
      if (this.token) {
        this.pull();
      } else {
        this._updateBadge('disconnected', 'Connect Sync');
      }
    },

    setGistId: function (id) {
      this.gistId = (id || DEFAULT_GIST_ID).trim();
      localStorage.setItem(GIST_ID_KEY, this.gistId);
    },

    /* ══════════════════════════════════════
       PULL: Fetch data from GitHub Gist
    ══════════════════════════════════════ */
    pull: function (callback) {
      var self = this;
      if (!this.token) {
        this._updateBadge('disconnected', 'Connect Sync');
        if (callback) callback(new Error('No token'));
        return;
      }

      this._updateBadge('syncing', 'Syncing...');

      var filename = this.appId + '.json';
      var url = 'https://api.github.com/gists/' + this.gistId;

      fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': 'token ' + this.token,
          'Accept': 'application/vnd.github.v3+json'
        }
      })
      .then(function (res) {
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) {
            throw new Error('Invalid token or insufficient permissions');
          } else if (res.status === 404) {
            throw new Error('Gist not found');
          }
          throw new Error('HTTP ' + res.status);
        }
        return res.json();
      })
      .then(function (gist) {
        self.lastSyncTime = new Date().toISOString();
        localStorage.setItem(LAST_SYNC_KEY, self.lastSyncTime);

        var fileObj = gist.files && gist.files[filename];
        var remoteData = null;
        if (fileObj && fileObj.content) {
          try {
            remoteData = JSON.parse(fileObj.content);
          } catch (e) {
            console.warn('[CloudSync] Could not parse remote content:', e);
          }
        }

        if (remoteData) {
          if (self.onPullCallback) {
            self.onPullCallback(remoteData);
          } else if (self.autoLocalStorage && remoteData.storage) {
            // Restore local storage items
            for (var k in remoteData.storage) {
              try {
                localStorage.setItem(k, remoteData.storage[k]);
              } catch (e) {}
            }
            window.dispatchEvent(new CustomEvent('cloud-sync-applied', { detail: remoteData }));
          }
        }

        self._updateBadge('synced', 'Synced');
        self._updateModalView();
        if (callback) callback(null, remoteData);
      })
      .catch(function (err) {
        console.warn('[CloudSync] Pull error:', err.message);
        self._updateBadge('error', 'Sync Failed');
        self._updateModalView(err.message);
        if (callback) callback(err);
      });
    },

    /* ══════════════════════════════════════
       PUSH: Save data to GitHub Gist
    ══════════════════════════════════════ */
    push: function (data, immediate) {
      var self = this;
      if (!this.token) return;

      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }

      var doPush = function () {
        self._updateBadge('syncing', 'Saving...');

        var payload = data;
        if (!payload && self.getPayloadCallback) {
          payload = self.getPayloadCallback();
        } else if (!payload && self.autoLocalStorage) {
          // Default: Collect all localStorage items for this domain
          var store = {};
          for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            // Skip sync internal keys
            if (k !== TOKEN_KEY && k !== GIST_ID_KEY && k !== LAST_SYNC_KEY) {
              store[k] = localStorage.getItem(k);
            }
          }
          payload = {
            appId: self.appId,
            updatedAt: new Date().toISOString(),
            storage: store
          };
        }

        if (!payload) return;

        var filename = self.appId + '.json';
        var filesPayload = {};
        filesPayload[filename] = {
          content: JSON.stringify(payload, null, 2)
        };

        var url = 'https://api.github.com/gists/' + self.gistId;

        fetch(url, {
          method: 'PATCH',
          headers: {
            'Authorization': 'token ' + self.token,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            files: filesPayload
          })
        })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function () {
          self.lastSyncTime = new Date().toISOString();
          localStorage.setItem(LAST_SYNC_KEY, self.lastSyncTime);
          self._updateBadge('synced', 'Synced');
          self._updateModalView();
        })
        .catch(function (err) {
          console.warn('[CloudSync] Push error:', err.message);
          self._updateBadge('error', 'Save Failed');
          self._updateModalView(err.message);
        });
      };

      if (immediate) {
        doPush();
      } else {
        this.debounceTimer = setTimeout(doPush, 1500);
      }
    },

    /* ══════════════════════════════════════
       LOCAL STORAGE HOOK
    ══════════════════════════════════════ */
    _hookLocalStorage: function () {
      var self = this;
      var origSetItem = Storage.prototype.setItem;
      var origRemoveItem = Storage.prototype.removeItem;

      Storage.prototype.setItem = function (k, v) {
        origSetItem.apply(this, arguments);
        if (this === localStorage && k !== TOKEN_KEY && k !== GIST_ID_KEY && k !== LAST_SYNC_KEY) {
          self.push();
        }
      };

      Storage.prototype.removeItem = function (k) {
        origRemoveItem.apply(this, arguments);
        if (this === localStorage && k !== TOKEN_KEY && k !== GIST_ID_KEY && k !== LAST_SYNC_KEY) {
          self.push();
        }
      };
    },

    /* ══════════════════════════════════════
       UI: STYLES, BADGE & MODAL
    ══════════════════════════════════════ */
    _injectStyles: function () {
      if (document.getElementById('cloud-sync-styles')) return;
      var style = document.createElement('style');
      style.id = 'cloud-sync-styles';
      style.textContent = [
        '#cs-badge { position: fixed; bottom: 12px; right: 12px; z-index: 99999; display: flex; align-items: center; gap: 6px; padding: 6px 11px; background: rgba(18, 24, 38, 0.88); color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 12px; font-weight: 500; border-radius: 999px; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.12); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); transition: all 0.2s ease; user-select: none; }',
        '#cs-badge:hover { transform: translateY(-1px); background: rgba(28, 36, 54, 0.95); border-color: rgba(255,255,255,0.25); }',
        '#cs-badge .cs-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }',
        '#cs-badge.synced .cs-dot { background: #10b981; box-shadow: 0 0 6px #10b981; }',
        '#cs-badge.syncing .cs-dot { background: #3b82f6; animation: cs-pulse 1s infinite alternate; }',
        '#cs-badge.error .cs-dot { background: #ef4444; }',
        '#cs-badge.disconnected .cs-dot { background: #f59e0b; }',
        '@keyframes cs-pulse { 0% { opacity: 0.4; } 100% { opacity: 1; } }',
        '#cs-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.65); z-index: 100000; display: none; align-items: center; justify-content: center; backdrop-filter: blur(4px); padding: 16px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }',
        '#cs-modal { background: #0f172a; color: #f1f5f9; width: 100%; max-width: 440px; border-radius: 16px; border: 1px solid rgba(255,255,255,0.15); box-shadow: 0 20px 40px rgba(0,0,0,0.5); overflow: hidden; }',
        '#cs-modal-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.03); }',
        '#cs-modal-header h3 { margin: 0; font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 8px; }',
        '#cs-modal-close { background: transparent; border: none; color: #94a3b8; font-size: 20px; cursor: pointer; padding: 4px; border-radius: 6px; }',
        '#cs-modal-close:hover { color: #fff; background: rgba(255,255,255,0.1); }',
        '#cs-modal-body { padding: 20px; font-size: 13px; line-height: 1.5; }',
        '#cs-modal-body p { margin: 0 0 14px 0; color: #94a3b8; }',
        '#cs-modal-body label { display: block; font-weight: 600; margin-bottom: 6px; color: #cbd5e1; font-size: 12px; }',
        '#cs-modal-body input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid #334155; background: #1e293b; color: #f8fafc; font-family: inherit; font-size: 13px; margin-bottom: 14px; outline: none; }',
        '#cs-modal-body input:focus { border-color: #38bdf8; box-shadow: 0 0 0 2px rgba(56,189,248,0.2); }',
        '.cs-btn-row { display: flex; gap: 8px; margin-top: 10px; }',
        '.cs-btn { flex: 1; padding: 10px 14px; border-radius: 8px; border: none; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.15s ease; text-align: center; }',
        '.cs-btn-primary { background: #0284c7; color: #fff; }',
        '.cs-btn-primary:hover { background: #0369a1; }',
        '.cs-btn-secondary { background: #334155; color: #e2e8f0; }',
        '.cs-btn-secondary:hover { background: #475569; }',
        '.cs-btn-danger { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }',
        '.cs-btn-danger:hover { background: rgba(239, 68, 68, 0.25); }',
        '.cs-status-box { padding: 10px 14px; border-radius: 8px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); margin-bottom: 16px; font-size: 12px; }',
        '.cs-link { color: #38bdf8; text-decoration: none; }',
        '.cs-link:hover { text-decoration: underline; }'
      ].join('\n');
      document.head.appendChild(style);
    },

    _createBadge: function () {
      var badge = document.createElement('div');
      badge.id = 'cs-badge';
      badge.className = 'disconnected';
      badge.innerHTML = '<span class="cs-dot"></span><span id="cs-badge-text">Cloud Sync</span>';
      var self = this;
      badge.onclick = function () {
        self.openModal();
      };
      document.body.appendChild(badge);
    },

    _updateBadge: function (status, text) {
      this.status = status;
      var badge = document.getElementById('cs-badge');
      var badgeText = document.getElementById('cs-badge-text');
      if (badge && badgeText) {
        badge.className = status;
        badgeText.textContent = text;
      }
    },

    _createModal: function () {
      var backdrop = document.createElement('div');
      backdrop.id = 'cs-modal-backdrop';
      backdrop.innerHTML = [
        '<div id="cs-modal">',
        '  <div id="cs-modal-header">',
        '    <h3>☁️ GitHub Cloud Sync</h3>',
        '    <button id="cs-modal-close" type="button">✕</button>',
        '  </div>',
        '  <div id="cs-modal-body"></div>',
        '</div>'
      ].join('\n');

      var self = this;
      backdrop.onclick = function (e) {
        if (e.target === backdrop) self.closeModal();
      };
      document.body.appendChild(backdrop);

      document.getElementById('cs-modal-close').onclick = function () {
        self.closeModal();
      };
    },

    openModal: function () {
      this._updateModalView();
      var backdrop = document.getElementById('cs-modal-backdrop');
      if (backdrop) backdrop.style.display = 'flex';
    },

    closeModal: function () {
      var backdrop = document.getElementById('cs-modal-backdrop');
      if (backdrop) backdrop.style.display = 'none';
    },

    _updateModalView: function (errorMsg) {
      var body = document.getElementById('cs-modal-body');
      if (!body) return;

      var self = this;
      var timeStr = this.lastSyncTime ? new Date(this.lastSyncTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Never';

      if (this.token) {
        body.innerHTML = [
          '<div class="cs-status-box">',
          '  <div style="display:flex; justify-content:space-between; margin-bottom:4px;">',
          '    <span>Status:</span><strong style="color:' + (this.status === 'error' ? '#f87171' : '#34d399') + ';">' + (this.status === 'error' ? 'Error' : 'Connected & Active') + '</strong>',
          '  </div>',
          '  <div style="display:flex; justify-content:space-between; margin-bottom:4px;">',
          '    <span>Last Synced:</span><span>' + timeStr + '</span>',
          '  </div>',
          '  <div style="display:flex; justify-content:space-between;">',
          '    <span>Gist:</span><a class="cs-link" href="https://gist.github.com/hassanakhter079/' + this.gistId + '" target="_blank">' + this.gistId.slice(0, 8) + '...</a>',
          '  </div>',
          (errorMsg ? '  <div style="margin-top:6px; color:#f87171;">' + errorMsg + '</div>' : ''),
          '</div>',
          '<p>Sync is active across all apps on <code>hassanakhter079.github.io</code>. Any changes made on this device are automatically saved to your GitHub Gist.</p>',
          '<div class="cs-btn-row">',
          '  <button class="cs-btn cs-btn-primary" id="cs-btn-sync" type="button">🔄 Sync Now</button>',
          '  <button class="cs-btn cs-btn-secondary" id="cs-btn-edit-token" type="button">Edit Token</button>',
          '  <button class="cs-btn cs-btn-danger" id="cs-btn-disconnect" type="button">Disconnect</button>',
          '</div>'
        ].join('\n');

        document.getElementById('cs-btn-sync').onclick = function () {
          self.pull(function (err) {
            if (!err) self.push(null, true);
          });
        };
        document.getElementById('cs-btn-edit-token').onclick = function () {
          self._showTokenInput(body, true);
        };
        document.getElementById('cs-btn-disconnect').onclick = function () {
          if (confirm('Disconnect GitHub Cloud Sync on this browser?')) {
            self.setToken('');
          }
        };
      } else {
        this._showTokenInput(body, false);
      }
    },

    _showTokenInput: function (body, isEditing) {
      var self = this;
      body.innerHTML = [
        '<p>Sync your prayer progress, patient lists, and trackers automatically across phone, tablet, and PC.</p>',
        '<div class="cs-status-box" style="margin-bottom:12px;">',
        '  <strong>How to connect:</strong><br>',
        '  1. Generate a GitHub Personal Access Token with <code>gist</code> scope:<br>',
        '  <a class="cs-link" href="https://github.com/settings/tokens/new?scopes=gist&description=Hassan+Apps+Cloud+Sync" target="_blank" style="display:inline-block; margin-top:4px;">🔗 Generate Token on GitHub (1-click)</a><br>',
        '  2. Paste your token below. It will automatically work for <strong>all apps</strong> on this device.',
        '</div>',
        '<label for="cs-token-input">GitHub Access Token (PAT):</label>',
        '<input id="cs-token-input" type="password" placeholder="ghp_xxxxxxxxxxxxxxxxxxxx" value="' + (isEditing ? this.token : '') + '">',
        '<div class="cs-btn-row">',
        '  <button class="cs-btn cs-btn-primary" id="cs-btn-save-token" type="button">Save & Connect</button>',
        (isEditing ? '  <button class="cs-btn cs-btn-secondary" id="cs-btn-cancel-token" type="button">Cancel</button>' : ''),
        '</div>'
      ].join('\n');

      document.getElementById('cs-btn-save-token').onclick = function () {
        var input = document.getElementById('cs-token-input');
        var val = (input && input.value || '').trim();
        if (!val) {
          alert('Please paste a GitHub token.');
          return;
        }
        self.setToken(val);
      };

      if (isEditing) {
        document.getElementById('cs-btn-cancel-token').onclick = function () {
          self._updateModalView();
        };
      }
    }
  };

  // Expose globally
  global.CloudSync = CloudSync;

  // Auto-init on DOMContentLoaded or immediately if DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      CloudSync.init();
    });
  } else {
    CloudSync.init();
  }

})(typeof window !== 'undefined' ? window : this);
