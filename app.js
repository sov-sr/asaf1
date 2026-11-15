// ============================================
// ASAF - Frontend
// ============================================
const $ = (id) => document.getElementById(id);

const state = {
  conversationId: null,
  pendingImage: null,
  sending: false,
  lang: localStorage.getItem('asaf_lang') || 'tr'
};

// ---------- Translations ----------
const i18n = {
  tr: {
    subtitle: 'İstinaf Dilekçesi Asistanı',
    email: 'E-posta',
    password: 'Şifre',
    login: 'Giriş Yap',
    newChat: 'Yeni Sohbet',
    logout: 'Çıkış',
    chats: 'Sohbetler',
    welcomeTitle: "ASAF'a Hoş Geldiniz",
    welcomeText: 'Mahkeme kararını yapıştırın, fotoğrafını yükleyin veya olayı anlatın.',
    welcomeWarn: '⚠️ Bu araç taslak üretir. Sunmadan önce avukata danışın. İstinaf süresi: 14 gün (hukuk/ceza) veya 30 gün (idari).',
    placeholder: 'Buraya yazın... (Göndermek için Ctrl+Enter)',
    photo: '📎 Fotoğraf',
    send: 'Gönder',
    typing: 'Yazıyor...',
    error: 'Hata',
    loginRequired: 'E-posta ve şifre gerekli',
    loginFail: 'Giriş başarısız',
    imgTooBig: 'Fotoğraf çok büyük (maks. 8MB)',
    photoTag: '[Fotoğraf]',
    sessionEnded: 'Oturum sona erdi'
  },
  ar: {
    subtitle: 'مساعد مذكرات الاستئناف',
    email: 'البريد الإلكتروني',
    password: 'كلمة المرور',
    login: 'دخول',
    newChat: 'محادثة جديدة',
    logout: 'خروج',
    chats: 'المحادثات',
    welcomeTitle: 'مرحباً بك في ASAF',
    welcomeText: 'الصق قرار المحكمة، ارفع صورة له، أو اشرح الواقعة.',
    welcomeWarn: '⚠️ هذه الأداة تُنتج مسودة. راجع محامياً قبل التقديم. مدة الاستئناف: 14 يوماً (مدني/جنائي) أو 30 يوماً (إداري).',
    placeholder: 'اكتب هنا... (Ctrl+Enter للإرسال)',
    photo: '📎 صورة',
    send: 'إرسال',
    typing: 'يكتب...',
    error: 'خطأ',
    loginRequired: 'البريد وكلمة المرور مطلوبان',
    loginFail: 'فشل الدخول',
    imgTooBig: 'الصورة كبيرة جداً (حد أقصى 8MB)',
    photoTag: '[صورة]',
    sessionEnded: 'انتهت الجلسة'
  }
};

const t = (key) => i18n[state.lang][key] || key;

function applyLang() {
  document.documentElement.lang = state.lang;
  document.body.classList.toggle('ar', state.lang === 'ar');
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPh);
  });
  document.querySelectorAll('[data-lang]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === state.lang);
  });
  localStorage.setItem('asaf_lang', state.lang);
}

document.querySelectorAll('[data-lang]').forEach(btn => {
  btn.addEventListener('click', () => {
    state.lang = btn.dataset.lang;
    applyLang();
  });
});

// ---------- API ----------
async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  if (res.status === 401) { showLogin(); throw new Error(t('sessionEnded')); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'İstek başarısız');
  return data;
}

// ---------- Login ----------
function showLogin() { $('loginScreen').classList.remove('hidden'); $('appScreen').classList.add('hidden'); }
function showApp() { $('loginScreen').classList.add('hidden'); $('appScreen').classList.remove('hidden'); }

$('loginBtn').addEventListener('click', async () => {
  const email = $('email').value.trim();
  const password = $('password').value;
  $('loginError').textContent = '';
  if (!email || !password) { $('loginError').textContent = t('loginRequired'); return; }
  try {
    $('loginBtn').disabled = true;
    await api('/api/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    $('password').value = '';
    showApp();
    loadConversations();
  } catch (err) {
    $('loginError').textContent = err.message || t('loginFail');
  } finally {
    $('loginBtn').disabled = false;
  }
});
$('password').addEventListener('keydown', e => { if (e.key === 'Enter') $('loginBtn').click(); });

$('logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  state.conversationId = null;
  showLogin();
});

// ---------- Conversations ----------
async function loadConversations() {
  try {
    const list = await api('/api/conversations');
    const ul = $('convList');
    ul.innerHTML = '';
    list.forEach(c => {
      const li = document.createElement('li');
      li.textContent = c.title || '—';
      li.dataset.id = c.id;
      if (c.id === state.conversationId) li.classList.add('active');
      li.addEventListener('click', () => openConversation(c.id));
      ul.appendChild(li);
    });
  } catch (err) { console.error(err); }
}

async function openConversation(id) {
  state.conversationId = id;
  $('chatMessages').innerHTML = '';
  const msgs = await api(`/api/conversations/${id}`);
  msgs.forEach(m => addMessage(m.role, m.content));
  loadConversations();
}

$('newChatBtn').addEventListener('click', () => {
  state.conversationId = null;
  state.pendingImage = null;
  $('chatMessages').innerHTML = `
    <div class="welcome">
      <h2>${t('welcomeTitle')}</h2>
      <p>${t('welcomeText')}</p>
      <p class="warning">${t('welcomeWarn')}</p>
    </div>`;
  $('imagePreview').classList.add('hidden');
  $('userInput').value = '';
  loadConversations();
});

// ---------- Image ----------
$('imageInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) { alert(t('imgTooBig')); return; }
  const reader = new FileReader();
  reader.onload = () => {
    state.pendingImage = reader.result;
    const preview = $('imagePreview');
    preview.innerHTML = `<img src="${reader.result}" /><button id="removeImg">×</button>`;
    preview.classList.remove('hidden');
    $('removeImg').addEventListener('click', () => {
      state.pendingImage = null;
      preview.classList.add('hidden');
      $('imageInput').value = '';
    });
  };
  reader.readAsDataURL(file);
});

// ---------- Send ----------
async function sendMessage() {
  if (state.sending) return;
  const text = $('userInput').value.trim();
  if (!text && !state.pendingImage) return;

  state.sending = true;
  $('sendBtn').disabled = true;

  const welcome = document.querySelector('.welcome');
  if (welcome) welcome.remove();

  addMessage('user', text || t('photoTag'), state.pendingImage);
  $('userInput').value = '';
  const imgToSend = state.pendingImage;
  state.pendingImage = null;
  $('imagePreview').classList.add('hidden');
  $('imageInput').value = '';

  const loadingEl = addMessage('assistant', t('typing'), null, true);

  try {
    const data = await api('/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        message: text,
        image: imgToSend,
        conversationId: state.conversationId,
        lang: state.lang
      })
    });
    loadingEl.remove();
    addMessage('assistant', data.reply);
    state.conversationId = data.conversationId;
    loadConversations();
  } catch (err) {
    loadingEl.remove();
    addMessage('assistant', `⚠️ ${t('error')}: ${err.message}`);
  } finally {
    state.sending = false;
    $('sendBtn').disabled = false;
  }
}

$('sendBtn').addEventListener('click', sendMessage);
$('userInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendMessage(); }
});

function addMessage(role, content, imageData = null, isLoading = false) {
  const div = document.createElement('div');
  div.className = `msg ${role}${isLoading ? ' loading' : ''}`;
  if (imageData) {
    const img = document.createElement('img');
    img.src = imageData;
    div.appendChild(img);
  }
  const span = document.createElement('span');
  span.textContent = content;
  div.appendChild(span);
  $('chatMessages').appendChild(div);
  $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
  return div;
}

// ---------- Init ----------
(async function init() {
  applyLang();
  try {
    await api('/api/me');
    showApp();
    loadConversations();
  } catch {
    showLogin();
  }
})();
