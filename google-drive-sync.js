/*
 * Rent-Flow Google Drive backup helper.
 *
 * HTML setup:
 *   <script src="https://accounts.google.com/gsi/client" async defer></script>
 *   <script src="google-drive-sync.js" defer></script>
 *   <button type="button" onclick="uploadToGoogleDrive()">一键同步到 Google 网盘（防手机丢失）</button>
 *   <button type="button" onclick="loadFromGoogleDrive()">从网盘恢复历史数据</button>
 *   <p id="driveSyncStatus" role="status" aria-live="polite"></p>
 *
 * Replace YOUR_CLIENT_ID with the OAuth 2.0 Web client ID.
 * Required OAuth scopes: https://www.googleapis.com/auth/drive.file,
 * https://www.googleapis.com/auth/userinfo.email and
 * https://www.googleapis.com/auth/userinfo.profile
 */
(() => {
    'use strict';

    const GOOGLE_CLIENT_ID = '51963447636-omne8ibrk4ff6ij11ojcbmusin3sngtp.apps.googleusercontent.com';
    const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
    const EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';
    const PROFILE_SCOPE = 'https://www.googleapis.com/auth/userinfo.profile';
    const PROFILE_SCOPES = `${EMAIL_SCOPE} ${PROFILE_SCOPE}`;
    const DRIVE_SCOPES = `${DRIVE_SCOPE} ${PROFILE_SCOPES}`;
    const ACCOUNT_EMAIL_KEY = '__rental_google_account_email';
    const ACCOUNT_PROFILE_KEY = '__rental_google_account_profile';
    const DISPLAY_NAME_KEY = '__rental_google_display_name';
    const LOCAL_ACCOUNT_KEYS = new Set([ACCOUNT_EMAIL_KEY, ACCOUNT_PROFILE_KEY, DISPLAY_NAME_KEY]);
    const GOOGLE_USERINFO_API = 'https://www.googleapis.com/oauth2/v3/userinfo';
    const BACKUP_FILENAME = 'Rent-Flow-Backup.json';
    const BACKUP_MIME_TYPE = 'application/json';
    const ENCRYPTED_BACKUP_FORMAT = 'rent-flow-encrypted-backup';
    const BACKUP_FORMAT = 'rent-flow-localstorage-backup';
    const PBKDF2_ITERATIONS = 600000;
    const DRIVE_API = 'https://www.googleapis.com/drive/v3';
    const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

    let tokenClient = null;
    let tokenClientScopes = '';
    let accessToken = null;
    let accessTokenScopes = '';
    let tokenExpiresAt = 0;
    let pendingTokenRequest = null;
    let accountEmail = localStorage.getItem(ACCOUNT_EMAIL_KEY) || '';
    let accountEmailToken = null;
    let accountProfile = {};

    try {
        const savedProfile = JSON.parse(localStorage.getItem(ACCOUNT_PROFILE_KEY) || 'null');
        accountProfile = savedProfile && typeof savedProfile === 'object' && !Array.isArray(savedProfile)
            ? savedProfile
            : {};
    } catch {
        accountProfile = {};
    }

    function showGoogleAccount(email) {
        const status = document.getElementById('googleAccountStatus');
        if (status) status.textContent = `当前账号：${email || '未绑定'}`;
        const avatar = document.getElementById('accountAvatar');
        const placeholder = document.getElementById('accountAvatarPlaceholder');
        if (avatar && placeholder) {
            if (email && typeof accountProfile.picture === 'string' && accountProfile.picture.startsWith('https://')) {
                avatar.src = accountProfile.picture;
                avatar.onerror = () => {
                    avatar.hidden = true;
                    placeholder.hidden = false;
                };
                avatar.hidden = false;
                placeholder.hidden = true;
            } else {
                avatar.removeAttribute('src');
                avatar.hidden = true;
                placeholder.hidden = false;
            }
        }
        const nameInput = document.getElementById('accountDisplayName');
        if (nameInput) {
            nameInput.value = localStorage.getItem(DISPLAY_NAME_KEY) || accountProfile.name || '';
        }
    }

    function saveGoogleAccountEmail(email, token) {
        const normalizedEmail = typeof email === 'string' ? email.trim() : '';
        if (!normalizedEmail) throw new Error('Google 未返回账号邮箱，请检查授权后重试。');
        localStorage.setItem(ACCOUNT_EMAIL_KEY, normalizedEmail);
        accountEmail = normalizedEmail;
        accountEmailToken = token;
        showGoogleAccount(accountEmail);
    }

    function saveGoogleAccountProfile(profile, token) {
        accountProfile = {
            name: typeof profile?.name === 'string' ? profile.name : '',
            picture: typeof profile?.picture === 'string' && profile.picture.startsWith('https://') ? profile.picture : ''
        };
        localStorage.setItem(ACCOUNT_PROFILE_KEY, JSON.stringify(accountProfile));
        saveGoogleAccountEmail(profile.email, token);
    }

    function setAccountStatus(message, isError = false) {
        const status = document.getElementById('accountManagementStatus');
        if (!status) return;
        status.textContent = message;
        status.style.color = isError ? '#b03a2e' : '#706778';
    }

    function saveAccountDisplayName() {
        const input = document.getElementById('accountDisplayName');
        if (!input) return;
        const name = input.value.trim();
        if (name) localStorage.setItem(DISPLAY_NAME_KEY, name);
        else localStorage.removeItem(DISPLAY_NAME_KEY);
        showGoogleAccount(accountEmail);
        setAccountStatus(name ? '显示名称已保存在此设备。' : '已恢复使用 Google 昵称。');
    }

    async function bindGoogleAccount() {
        setAccountStatus('正在连接 Google 并读取账号资料…');
        try {
            const token = await requestDriveAccess(PROFILE_SCOPES, accountEmail ? 'select_account' : '');
            await updateGoogleAccountEmail(token);
            setAccountStatus('Google 账号已绑定。此操作没有上传或更改网盘数据。');
        } catch (error) {
            console.error(error);
            showGoogleAccount(accountEmail);
            setAccountStatus(error.message || '绑定 Google 账号失败，请重试。', true);
            alert(error.message || '绑定 Google 账号失败，请重试。');
        }
    }

    function requireBoundGoogleAccount(action) {
        if (accountEmail) return true;
        const message = `请先前往「账号与绑定」页面绑定 Google 账号，再${action}。`;
        setStatus(message, true);
        alert(message);
        location.hash = 'account';
        return false;
    }

    async function updateGoogleAccountEmail(token) {
        if (accountEmail && accountEmailToken === token) return;

        showGoogleAccount('加载中...');
        const response = await fetch(GOOGLE_USERINFO_API, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!response.ok) {
            throw new Error(`读取 Google 账号邮箱失败（${response.status}）。请重新授权后重试。`);
        }
        const profile = await response.json();
        saveGoogleAccountProfile(profile, token);
    }

    showGoogleAccount(accountEmail);

    function setStatus(message, isError = false) {
        const status = document.getElementById('driveSyncStatus');
        if (!status) return;
        status.textContent = message;
        status.style.color = isError ? '#b03a2e' : '#6657A5';
    }

    function initGoogleDriveAuth(scopes = DRIVE_SCOPES) {
        if (tokenClient && tokenClientScopes === scopes) return tokenClient;
        if (location.protocol === 'file:') {
            throw new Error('当前网页是从本地文件（file://）打开的，Google 不允许从本地文件授权。请通过 HTTPS 网站地址访问，并在 Google OAuth 设置中加入对应的网站来源。');
        }
        if (!window.google?.accounts?.oauth2) {
            throw new Error('Google 登录组件还没加载完成，请稍后重试。');
        }
        if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID === 'YOUR_CLIENT_ID') {
            throw new Error('请先在 google-drive-sync.js 中填写 Google OAuth Client ID。');
        }

        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: GOOGLE_CLIENT_ID,
            scope: scopes,
            callback: (response) => {
                if (!pendingTokenRequest) return;
                if (response?.error || !response?.access_token) {
                    showGoogleAccount(accountEmail);
                    pendingTokenRequest.reject(new Error(
                        response?.error_description || response?.error || '没有取得 Google 授权，请重试。'
                    ));
                    pendingTokenRequest = null;
                    return;
                }
                accessToken = response.access_token;
                accessTokenScopes = pendingTokenRequest.scopes;
                tokenExpiresAt = Date.now() + (Number(response.expires_in || 3600) - 30) * 1000;
                pendingTokenRequest.resolve(accessToken);
                pendingTokenRequest = null;
            },
            error_callback: (error) => {
                console.error('Google 授权窗口错误：', error);
                showGoogleAccount(accountEmail);
                if (pendingTokenRequest) {
                    pendingTokenRequest.reject(new Error(error?.message || 'Google 授权窗口无法打开。'));
                    pendingTokenRequest = null;
                }
            }
        });
        tokenClientScopes = scopes;
        return tokenClient;
    }

    function requestDriveAccess(scopes = DRIVE_SCOPES, prompt = '') {
        return new Promise((resolve, reject) => {
            let client;
            try {
                client = initGoogleDriveAuth(scopes);
            } catch (error) {
                reject(error);
                return;
            }

            pendingTokenRequest = { resolve, reject, scopes };

            // GIS token 会过期，且只保存在内存中；每次用户主动同步时重新请求。
            showGoogleAccount('加载中...');
            try {
                client.requestAccessToken({ prompt });
            } catch (error) {
                showGoogleAccount(accountEmail);
                pendingTokenRequest = null;
                reject(error);
            }
        });
    }

    async function getDriveToken() {
        try {
            if (!accessToken || Date.now() >= tokenExpiresAt || !accessTokenScopes.split(/\s+/).includes(DRIVE_SCOPE)) {
                accessToken = await requestDriveAccess(DRIVE_SCOPES);
            }
            await updateGoogleAccountEmail(accessToken);
            return accessToken;
        } catch (error) {
            showGoogleAccount(accountEmail);
            throw error;
        }
    }

    function clearGoogleAccountBinding() {
        localStorage.removeItem(ACCOUNT_EMAIL_KEY);
        localStorage.removeItem(ACCOUNT_PROFILE_KEY);
        accountEmail = '';
        accountProfile = {};
        accountEmailToken = null;
        accessToken = null;
        accessTokenScopes = '';
        tokenExpiresAt = 0;
        showGoogleAccount('');
    }

    function cancelGoogleAccountBinding() {
        if (!accountEmail && !accessToken) {
            setAccountStatus('当前没有已绑定的 Google 账号。');
            return;
        }
        const accountLabel = accountEmail || '当前授权账号';
        if (!confirm(`确定取消绑定 Google 账号「${accountLabel}」吗？取消后，下次同步或恢复时需要重新授权。`)) return;

        const tokenToRevoke = accessToken;
        if (!tokenToRevoke) {
            clearGoogleAccountBinding();
            setAccountStatus('本机绑定已取消。此页面没有可撤销的授权令牌；如需完全撤销 Google 授权，请在 Google 账号已连接的应用中移除「房屋管理系统」。');
            return;
        }

        setAccountStatus('正在取消绑定…');
        const oauth2 = window.google?.accounts?.oauth2;
        if (!oauth2?.revoke) {
            clearGoogleAccountBinding();
            const message = '本机绑定已取消，但 Google 授权撤销组件不可用。若要完全撤销授权，请在 Google 账号已连接的应用中移除「房屋管理系统」。';
            setAccountStatus(message, true);
            alert(message);
            return;
        }

        try {
            oauth2.revoke(tokenToRevoke, response => {
                clearGoogleAccountBinding();
                if (response?.error || response?.successful === false) {
                    const message = '本机绑定已取消，但 Google 授权未能撤销。请在 Google 账号已连接的应用中移除「房屋管理系统」。';
                    setAccountStatus(message, true);
                    alert(message);
                    return;
                }
                setAccountStatus('Google 账号绑定和本次应用授权已取消。下次同步或恢复时需要重新授权。');
            });
        } catch (error) {
            console.error('取消 Google 授权失败：', error);
            clearGoogleAccountBinding();
            const message = `本机绑定已取消，但 Google 授权撤销失败：${error.message || '未知错误'}。请在 Google 账号已连接的应用中移除「房屋管理系统」。`;
            setAccountStatus(message, true);
            alert(message);
        }
    }

    async function driveRequest(url, options = {}) {
        const token = await getDriveToken();
        const response = await fetch(url, {
            ...options,
            headers: {
                Authorization: `Bearer ${token}`,
                ...(options.headers || {})
            }
        });

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            let message = `Google Drive 请求失败（${response.status}）。`;
            if (response.status === 401) {
                accessToken = null;
                accessTokenScopes = '';
                tokenExpiresAt = 0;
                message = 'Google 授权已过期，请再点一次同步或恢复。';
            } else if (response.status === 403) {
                message = 'Google 账号没有文件访问权限。请检查 Drive API、授权范围和 OAuth 设置。';
            }
            throw new Error(detail ? `${message}\n${detail}` : message);
        }
        if (response.status === 204) return null;
        return response.json();
    }

    function collectLocalStorage() {
        const entries = [];
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (key !== null && !LOCAL_ACCOUNT_KEYS.has(key)) entries.push([key, localStorage.getItem(key)]);
        }
        return {
            format: 'rent-flow-localstorage-backup',
            version: 1,
            savedAt: new Date().toISOString(),
            origin: location.origin,
            entries
        };
    }

    function bytesToBase64(bytes) {
        let binary = '';
        const chunkSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
        }
        return btoa(binary);
    }

    function base64ToBytes(value) {
        const binary = atob(value);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return bytes;
    }

    async function deriveEncryptionKey(password, salt, usage) {
        if (!window.crypto?.subtle) {
            throw new Error('此浏览器不支持安全加密，请使用最新版 Chrome、Edge 或 Safari。');
        }
        const passwordKey = await crypto.subtle.importKey(
            'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']
        );
        return crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
            passwordKey,
            { name: 'AES-GCM', length: 256 },
            false,
            [usage]
        );
    }

    async function encryptBackup(payload, password) {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await deriveEncryptionKey(password, salt, 'encrypt');
        const plaintext = new TextEncoder().encode(JSON.stringify(payload));
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
        return {
            format: ENCRYPTED_BACKUP_FORMAT,
            version: 1,
            cipher: 'AES-256-GCM',
            kdf: 'PBKDF2-SHA-256',
            iterations: PBKDF2_ITERATIONS,
            salt: bytesToBase64(salt),
            iv: bytesToBase64(iv),
            ciphertext: bytesToBase64(new Uint8Array(ciphertext))
        };
    }

    async function decryptBackup(envelope, password) {
        if (envelope?.format !== ENCRYPTED_BACKUP_FORMAT || envelope.version !== 1 ||
            envelope.cipher !== 'AES-256-GCM' || envelope.kdf !== 'PBKDF2-SHA-256' ||
            envelope.iterations !== PBKDF2_ITERATIONS || typeof envelope.salt !== 'string' ||
            typeof envelope.iv !== 'string' || typeof envelope.ciphertext !== 'string') {
            throw new Error('不支持的加密备份格式。');
        }
        const salt = base64ToBytes(envelope.salt);
        const iv = base64ToBytes(envelope.iv);
        const ciphertext = base64ToBytes(envelope.ciphertext);
        if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16) {
            throw new Error('加密备份内容不完整。');
        }
        const key = await deriveEncryptionKey(password, salt, 'decrypt');
        const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    }

    function isValidBackupPayload(payload) {
        return payload?.format === BACKUP_FORMAT && payload.version === 1 &&
            Array.isArray(payload.entries) && payload.entries.every(entry =>
                Array.isArray(entry) && entry.length === 2 &&
                typeof entry[0] === 'string' &&
                (typeof entry[1] === 'string' || entry[1] === null)
            );
    }

    async function findBackupFile() {
        // drive.file 只能列出此应用创建或用户明确交给此应用的文件。
        // 不会扫描用户 Drive 中所有同名文件。
        const query = `name = '${BACKUP_FILENAME}' and trashed = false`;
        const params = new URLSearchParams({
            q: query,
            spaces: 'drive',
            pageSize: '100',
            orderBy: 'modifiedTime desc',
            fields: 'files(id,name,mimeType,modifiedTime,size)'
        });
        const result = await driveRequest(`${DRIVE_API}/files?${params}`);
        const files = result.files || [];
        if (files.length > 1) {
            console.warn(`Drive 中找到 ${files.length} 个同名备份，将更新最近修改的一个。`);
        }
        return files[0] || null;
    }

    async function uploadBackupFile(payload) {
        const existing = await findBackupFile();
        const metadata = {
            name: BACKUP_FILENAME,
            mimeType: BACKUP_MIME_TYPE
        };
        const fileBody = new Blob([JSON.stringify(payload)], { type: BACKUP_MIME_TYPE });
        const url = existing
            ? `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(existing.id)}?uploadType=resumable&fields=id,name,modifiedTime`
            : `${DRIVE_UPLOAD_API}/files?uploadType=resumable&fields=id,name,modifiedTime`;
        const token = await getDriveToken();
        const startResponse = await fetch(url, {
            method: existing ? 'PATCH' : 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json; charset=UTF-8',
                'X-Upload-Content-Type': BACKUP_MIME_TYPE,
                'X-Upload-Content-Length': String(fileBody.size)
            },
            body: JSON.stringify(metadata)
        });
        if (!startResponse.ok) {
            const detail = await startResponse.text().catch(() => '');
            throw new Error(`无法开始上传备份（${startResponse.status}）。${detail}`);
        }
        const uploadUrl = startResponse.headers.get('Location');
        if (!uploadUrl) throw new Error('Google Drive 没有返回上传地址，请重试。');

        const uploadResponse = await fetch(uploadUrl, {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': BACKUP_MIME_TYPE
            },
            body: fileBody
        });
        if (!uploadResponse.ok) {
            const detail = await uploadResponse.text().catch(() => '');
            throw new Error(`备份上传失败（${uploadResponse.status}）。${detail}`);
        }
        return uploadResponse.json();
    }

    const BACKUP_PASSWORD_SYMBOLS = '!@#$%^&*()-_=+[]{};:,.?/\\|~';
    const BACKUP_PASSWORD_REQUIREMENTS = `至少 12 位，同时包含大写英文字母、小写英文字母、数字，以及至少一个符号（${BACKUP_PASSWORD_SYMBOLS}）。`;

    function validateBackupPassword(password) {
        const hasUppercase = /[A-Z]/.test(password);
        const hasLowercase = /[a-z]/.test(password);
        const hasDigit = /\d/.test(password);
        const hasSymbol = Array.from(BACKUP_PASSWORD_SYMBOLS).some(symbol => password.includes(symbol));
        return password.length >= 12 && hasUppercase && hasLowercase && hasDigit && hasSymbol;
    }

    function promptForBackupPassword() {
        const password = prompt(`请设置您的专属解密密码（忘记后无法恢复数据）。\n\n密码条件：${BACKUP_PASSWORD_REQUIREMENTS}`);
        if (password === null || password.length === 0) {
            setStatus('已取消同步。');
            return null;
        }
        if (!validateBackupPassword(password)) {
            alert('密码不符合要求：至少 12 位，并包含大写英文字母、小写英文字母、数字和至少一个符号。');
            setStatus('密码不符合安全要求，未上传。', true);
            return null;
        }
        const repeatedPassword = prompt('请再次输入专属解密密码以确认：');
        if (repeatedPassword === null || repeatedPassword.length === 0) {
            setStatus('已取消同步。');
            return null;
        }
        if (password !== repeatedPassword) {
            alert('两次输入的密码不一致，未上传备份。');
            setStatus('两次输入的密码不一致，未上传。', true);
            return null;
        }

        return password;
    }

    async function changeGoogleDriveBackupPassword() {
        if (!requireBoundGoogleAccount('更改网盘密码')) return;
        try {
            await getDriveToken();
        } catch (error) {
            console.error(error);
            setStatus(error.message || 'Google 授权失败，请重试。', true);
            alert(error.message || 'Google 授权失败，请重试。');
            return;
        }

        const oldPassword = prompt('请输入当前专属解密密码：');
        if (oldPassword === null || oldPassword.length === 0) {
            setStatus('已取消更改密码。');
            return;
        }

        const newPassword = prompt(`请输入新的专属解密密码。\n\n密码条件：${BACKUP_PASSWORD_REQUIREMENTS}`);
        if (newPassword === null || newPassword.length === 0) {
            setStatus('已取消更改密码。');
            return;
        }
        if (!validateBackupPassword(newPassword)) {
            alert('新密码不符合要求：至少 12 位，并包含大写英文字母、小写英文字母、数字和至少一个符号。');
            setStatus('新密码不符合安全要求，未更改。', true);
            return;
        }

        const repeatedPassword = prompt('请再次输入新的专属解密密码以确认：');
        if (repeatedPassword === null || repeatedPassword.length === 0) {
            setStatus('已取消更改密码。');
            return;
        }
        if (newPassword !== repeatedPassword) {
            alert('两次输入的新密码不一致，未更改。');
            setStatus('两次输入的新密码不一致，未更改。', true);
            return;
        }

        setStatus('正在连接 Google Drive…');
        try {
            const file = await findBackupFile();
            if (!file) throw new Error(`没有找到 ${BACKUP_FILENAME}，请先同步一份网盘备份。`);

            const response = await fetch(`${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media`, {
                headers: { Authorization: `Bearer ${accessToken}` }
            });
            if (!response.ok) throw new Error(`下载网盘备份失败（${response.status}）。`);

            let downloaded;
            try {
                downloaded = JSON.parse(await response.text());
            } catch (_) {
                throw new Error('网盘备份无法读取，密码未更改。');
            }

            let payload;
            if (downloaded?.format === ENCRYPTED_BACKUP_FORMAT) {
                try {
                    payload = await decryptBackup(downloaded, oldPassword);
                } catch (_) {
                    throw new Error('当前密码错误或网盘备份已损坏，密码未更改。');
                }
            } else if (downloaded?.format === BACKUP_FORMAT) {
                payload = downloaded;
            } else {
                throw new Error('网盘备份格式不正确，密码未更改。');
            }
            if (!isValidBackupPayload(payload)) {
                throw new Error('网盘备份数据格式不正确，密码未更改。');
            }

            const encryptedPayload = await encryptBackup(payload, newPassword);
            const result = await uploadBackupFile(encryptedPayload);
            setStatus(`专属解密密码已更改：${result.name}（${new Date(result.modifiedTime).toLocaleString()}）`);
            alert('网盘备份已使用新密码重新加密。请牢记新密码，恢复时需要输入新密码。');
        } catch (error) {
            console.error(error);
            setStatus(error.message || '更改密码失败，请检查网络和 Google 设置。', true);
            alert(error.message || '更改密码失败，请检查网络和 Google 设置。');
        }
    }

    async function uploadToGoogleDrive() {
        if (!requireBoundGoogleAccount('同步数据')) return;

        setStatus('正在连接 Google 并获取账号授权…');
        try {
            await getDriveToken();
        } catch (error) {
            console.error(error);
            setStatus(error.message || 'Google 授权失败，请检查网络和账号设置。', true);
            alert(error.message || 'Google 授权失败，请检查网络和账号设置。');
            return;
        }

        const password = promptForBackupPassword();
        if (password === null) return;

        setStatus('正在本地加密并连接 Google Drive…');
        try {
            const payload = collectLocalStorage();
            const encryptedPayload = await encryptBackup(payload, password);
            const result = await uploadBackupFile(encryptedPayload);
            setStatus(`备份完成：${result.name}（${new Date(result.modifiedTime).toLocaleString()}）`);
            alert('已将本地加密后的数据备份到 Google Drive。请妥善保管解密密码。');
        } catch (error) {
            console.error(error);
            setStatus(error.message || '备份失败，请检查网络和 Google 设置。', true);
            alert(error.message || '备份失败，请检查网络和 Google 设置。');
        }
    }

    async function loadFromGoogleDrive() {
        if (!requireBoundGoogleAccount('恢复网盘数据')) return;
        setStatus('正在查找 Google Drive 备份…');
        try {
            await getDriveToken();
            const file = await findBackupFile();
            if (!file) {
                throw new Error(`没有找到 ${BACKUP_FILENAME}。请先在原设备点“一键同步到 Google 网盘”。`);
            }
            const token = await getDriveToken();
            const response = await fetch(`${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            if (!response.ok) throw new Error(`下载备份失败（${response.status}）。`);

            let downloaded;
            try {
                downloaded = JSON.parse(await response.text());
            } catch (_) {
                alert('密码错误或备份损坏，无法恢复数据！');
                setStatus('备份内容无法读取，当前本地数据未更改。', true);
                return;
            }

            let payload;
            if (downloaded?.format === ENCRYPTED_BACKUP_FORMAT) {
                const password = prompt('请输入您备份时设置的专属解密密码：');
                if (password === null || password.length === 0) {
                    setStatus('已取消恢复，当前本地数据未更改。');
                    return;
                }
                try {
                    payload = await decryptBackup(downloaded, password);
                } catch (_) {
                    alert('密码错误或备份损坏，无法恢复数据！');
                    setStatus('密码错误或备份损坏，当前本地数据未更改。', true);
                    return;
                }
            } else if (downloaded?.format === BACKUP_FORMAT) {
                if (!confirm('这是升级加密功能前的旧版明文备份，尚未加密。确定要恢复吗？')) {
                    setStatus('已取消恢复，当前本地数据未更改。');
                    return;
                }
                payload = downloaded;
            } else {
                alert('密码错误或备份损坏，无法恢复数据！');
                setStatus('备份格式不正确，当前本地数据未更改。', true);
                return;
            }

            if (!isValidBackupPayload(payload)) {
                alert('密码错误或备份损坏，无法恢复数据！');
                setStatus('备份数据格式不正确，当前本地数据未更改。', true);
                return;
            }

            if (!confirm('恢复会替换此浏览器里的全部网站数据。建议先导出一份 Excel 备份。确定继续吗？')) {
                setStatus('已取消恢复，当前本地数据未更改。');
                return;
            }

            // 先留一份内存回滚副本；写入任何项目失败时恢复原有数据。
            const previousEntries = [];
            for (let index = 0; index < localStorage.length; index += 1) {
                const key = localStorage.key(index);
                if (key !== null) previousEntries.push([key, localStorage.getItem(key)]);
            }
            const localAccountEntries = previousEntries.filter(([key]) => LOCAL_ACCOUNT_KEYS.has(key));

            try {
                localStorage.clear();
                for (const [key, value] of payload.entries) {
                    if (LOCAL_ACCOUNT_KEYS.has(key)) continue;
                    if (value !== null) localStorage.setItem(key, value);
                }
                for (const [key, value] of localAccountEntries) {
                    if (value !== null) localStorage.setItem(key, value);
                }
            } catch (writeError) {
                localStorage.clear();
                for (const [key, value] of previousEntries) {
                    if (value !== null) localStorage.setItem(key, value);
                }
                throw new Error(`写入本地失败，原数据已恢复。${writeError.message}`);
            }

            setStatus(`恢复完成：${file.name}（备份时间：${payload.savedAt || '未知'}）`);
            alert('数据已恢复，网页即将重新载入。');
            location.reload();
        } catch (error) {
            console.error(error);
            setStatus(error.message || '恢复失败，请检查网络和 Google 设置。', true);
            alert(error.message || '恢复失败，请检查网络和 Google 设置。');
        }
    }

    window.uploadToGoogleDrive = uploadToGoogleDrive;
    window.loadFromGoogleDrive = loadFromGoogleDrive;
    window.changeGoogleDriveBackupPassword = changeGoogleDriveBackupPassword;
    window.bindGoogleAccount = bindGoogleAccount;
    window.saveAccountDisplayName = saveAccountDisplayName;
    window.cancelGoogleAccountBinding = cancelGoogleAccountBinding;
    window.initGoogleDriveAuth = initGoogleDriveAuth;
})();
