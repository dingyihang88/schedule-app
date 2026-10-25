// ============================================================
// 日程工作台 - 前端逻辑（Supabase 云端版）
// 数据存在云端数据库 Supabase，手机随时随地登录都能看到同一份数据
// 用原生 JS 写，不引框架，方便你读懂和日后自己改
// ============================================================

// 创建 Supabase 客户端（CONFIG 来自 config.js）
const sb = supabase.createClient(CONFIG.url, CONFIG.anonKey);

// 课程列表缓存（给作业/资料的"所属课程"下拉框用）
let courses = [];
// 作业排序模式：deadline（截止时间）| score（分数）| status（完成状态）
let hwSortMode = 'deadline';

// ---- 通用工具 ----
function shortDate(s) { return s ? s.slice(0, 10) : ''; }
function courseName(id) {
  if (!id) return '';
  const c = courses.find(x => x.id === Number(id));
  return c ? c.name : '';
}
// 防 XSS：把特殊字符转义后再插入 HTML
function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}
// 简易错误提示
function showErr(e, prefix) {
  console.error(prefix, e);
  alert((prefix || '') + (e && e.message ? e.message : e));
}

// ============================================================
// 登录 / 注册 / 退出
// ============================================================
document.getElementById('signInBtn').addEventListener('click', doSignIn);
document.getElementById('signUpBtn').addEventListener('click', doSignUp);
document.getElementById('logoutBtn').addEventListener('click', async () => {
  await sb.auth.signOut();
  document.body.classList.remove('logged-in');
  document.getElementById('loginMsg').textContent = '';
});

async function doSignIn() {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const msg = document.getElementById('loginMsg');
  msg.textContent = '登录中…';
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) { msg.textContent = error.message; return; }
  msg.textContent = '';
  enterApp();
}

async function doSignUp() {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const msg = document.getElementById('loginMsg');
  if (password.length < 6) { msg.textContent = '密码至少 6 位'; return; }
  msg.textContent = '注册中…';
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) { msg.textContent = error.message; return; }
  if (data.session) {
    // 未开邮箱确认时，注册完即登录
    msg.textContent = '';
    enterApp();
  } else {
    msg.textContent = '注册成功！请去邮箱点确认链接，回来再点登录。';
  }
}

// 进入主界面
function enterApp() {
  document.body.classList.add('logged-in');
  loadDashboard();
  checkDueReminders();
  // 每 5 分钟检查一次到期作业
  setInterval(checkDueReminders, 5 * 60 * 1000);
}

// 页面打开时检查是否已登录（session 还在就免登录）
async function initAuth() {
  const { data } = await sb.auth.getSession();
  if (data.session) enterApp();
}
initAuth();

// ============================================================
// 作业到期提醒：浏览器通知 + 工作台提醒条
// ============================================================
async function requestNotifyPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const r = await Notification.requestPermission();
  return r === 'granted';
}

function notify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification(title, { body, icon: 'icon.svg' }); } catch (e) {}
}

// 检查未来 3 天内到期的作业，弹通知 + 显示提醒条
async function checkDueReminders() {
  try {
    const { data: hw } = await sb.from('homework').select('*');
    const list = hw || [];
    const now = new Date();
    const in3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

    const dueSoon = list.filter(h => {
      if (h.done || !h.deadline) return false;
      const d = new Date(h.deadline);
      return d >= now && d <= in3Days;
    });

    // 工作台提醒条
    const bar = document.getElementById('reminderBar');
    if (bar) {
      if (dueSoon.length) {
        bar.style.display = 'block';
        bar.innerHTML = dueSoon.map(h =>
          `⚠️ 「${escapeHtml(h.title)}」${escapeHtml(shortDate(h.deadline))} 截止`
        ).join('<br>');
      } else {
        bar.style.display = 'none';
      }
    }

    // 弹浏览器通知（同一作业只弹一次，用 localStorage 记录）
    if (dueSoon.length) {
      await requestNotifyPermission();
      const notified = JSON.parse(localStorage.getItem('notifiedHw') || '[]');
      let changed = false;
      dueSoon.forEach(h => {
        if (!notified.includes(h.id)) {
          notify('作业即将到期', `${h.title} · ${shortDate(h.deadline)} 截止`);
          notified.push(h.id);
          changed = true;
        }
      });
      if (changed) localStorage.setItem('notifiedHw', JSON.stringify(notified));
    }
  } catch (e) { console.error('checkDueReminders', e); }
}

// ============================================================
// 标签页切换
// ============================================================
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const page = btn.dataset.page;
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + page));
    if (page === 'dashboard') loadDashboard();
    if (page === 'homework') loadHomework();
    if (page === 'courses') loadCourses();
    if (page === 'materials') loadMaterials();
    if (page === 'chores') loadChores();
  });
});

// ============================================================
// 工作台：一次性拉取作业/琐事/课程，算出今日概览
// ============================================================
async function loadDashboard() {
  const today = new Date().toISOString().slice(0, 10);

  const [{ data: hw }, { data: ch }, { data: co }] = await Promise.all([
    sb.from('homework').select('*'),
    sb.from('chores').select('*'),
    sb.from('courses').select('*')
  ]);

  const homework = hw || [];
  const chores = ch || [];
  const courseList = co || [];

  // 统计卡片
  const sc = document.getElementById('statCards');
  sc.innerHTML = `
    <div class="stat-card"><div class="num">${homework.filter(h => !h.done).length}</div><div class="lbl">未完成作业</div></div>
    <div class="stat-card"><div class="num">${courseList.length}</div><div class="lbl">课程数</div></div>
    <div class="stat-card"><div class="num">${chores.length}</div><div class="lbl">琐事总数</div></div>
  `;

  // 今日到期作业
  const dueHw = homework.filter(h => !h.done && h.deadline && h.deadline.slice(0, 10) === today);
  const dh = document.getElementById('dashHomework');
  dh.innerHTML = dueHw.length
    ? dueHw.map(h => `<li class="item"><div class="row1"><span class="title">${escapeHtml(h.title)}</span></div><div class="meta">${courseName(h.course_id) ? '<span class="tag">' + escapeHtml(courseName(h.course_id)) + '</span>' : ''}截止：${escapeHtml(shortDate(h.deadline))}</div></li>`).join('')
    : '<li class="empty">今天没有到期作业，安心做别的吧</li>';

  // 今日待办琐事
  const todayChores = chores.filter(c => !c.done && c.due_date && c.due_date.slice(0, 10) === today);
  const dc = document.getElementById('dashChores');
  dc.innerHTML = todayChores.length
    ? todayChores.map(c => `<li class="item"><div class="row1"><span class="title">${escapeHtml(c.title)}</span></div><div class="meta">待办：${escapeHtml(shortDate(c.due_date))}</div></li>`).join('')
    : '<li class="empty">今天没有待办琐事</li>';
}

// ============================================================
// 课程管理
// ============================================================
async function loadCourses() {
  const { data, error } = await sb.from('courses').select('*').order('created_at', { ascending: false });
  if (error) return showErr(error, '加载课程失败：');
  courses = data || [];
  fillCourseSelects();

  const list = document.getElementById('courseList');
  list.innerHTML = courses.length
    ? courses.map(c => `
      <li class="item">
        <div class="row1">
          <span class="title">${escapeHtml(c.name)}</span>
          <div class="ops">
            <button class="btn-del" onclick="delCourse(${c.id})">删除</button>
          </div>
        </div>
        <div class="meta">
          ${c.teacher ? '教师：' + escapeHtml(c.teacher) + '<br>' : ''}
          ${c.location ? '地点：' + escapeHtml(c.location) + '<br>' : ''}
          ${c.class_time ? '时间：' + escapeHtml(c.class_time) + '<br>' : ''}
          ${c.requirement ? '要求：' + escapeHtml(c.requirement) + '<br>' : ''}
          ${c.note ? '备注：' + escapeHtml(c.note) : ''}
        </div>
      </li>`).join('')
    : '<li class="empty">还没有课程，点上方"+ 添加课程"开始</li>';
}

document.getElementById('courseForm').addEventListener('submit', async e => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  const { error } = await sb.from('courses').insert(body);
  if (error) return showErr(error, '保存失败：');
  e.target.reset();
  loadCourses();
});

async function delCourse(id) {
  if (!confirm('确定删除这门课程？')) return;
  const { error } = await sb.from('courses').delete().eq('id', id);
  if (error) return showErr(error, '删除失败：');
  loadCourses();
}

// 排序按钮事件
document.querySelectorAll('.sort-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b === btn));
    hwSortMode = btn.dataset.sort;
    loadHomework();
  });
});

// ============================================================
// 作业管理
// ============================================================
async function loadHomework() {
  if (!courses.length) {
    const { data } = await sb.from('courses').select('*');
    courses = data || [];
  }
  fillCourseSelects();

  const { data, error } = await sb.from('homework').select('*').order('created_at', { ascending: false });
  if (error) return showErr(error, '加载作业失败：');
  let list = data || [];

  // 按选择的模式排序
  if (hwSortMode === 'score') {
    list.sort((a, b) => (b.score || 0) - (a.score || 0));
  } else if (hwSortMode === 'status') {
    list.sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0));
  } else {
    // deadline：未完成在前，再按截止时间升序
    list.sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0) || (a.deadline || '').localeCompare(b.deadline || ''));
  }

  const ul = document.getElementById('hwList');
  ul.innerHTML = list.length
    ? list.map(h => `
      <li class="item ${h.done ? 'is-done' : ''}">
        <div class="row1">
          <span class="title ${h.done ? 'done' : ''}">${escapeHtml(h.title)}</span>
          <div class="ops">
            <button class="btn-done ${h.done ? 'is-done' : ''}" onclick="toggleHw(${h.id}, ${!h.done})">${h.done ? '已做' : '完成'}</button>
            <button class="btn-del" onclick="delHw(${h.id})">删除</button>
          </div>
        </div>
        <div class="meta">
          ${courseName(h.course_id) ? '<span class="tag">' + escapeHtml(courseName(h.course_id)) + '</span>' : ''}
          ${h.deadline ? '截止：' + escapeHtml(h.deadline) : ''}
          ${h.score ? ' · 分数：' + escapeHtml(h.score) : ''}
        </div>
      </li>`).join('')
    : '<li class="empty">没有作业记录</li>';
}

document.getElementById('hwForm').addEventListener('submit', async e => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  body.done = false;
  if (body.course_id === '') delete body.course_id;
  else body.course_id = Number(body.course_id);
  if (body.deadline === '') delete body.deadline;
  if (body.score === '' || body.score === null) delete body.score;
  else body.score = Number(body.score);
  const { error } = await sb.from('homework').insert(body);
  if (error) return showErr(error, '保存失败：');
  e.target.reset();
  loadHomework();
});

async function toggleHw(id, done) {
  const { error } = await sb.from('homework').update({ done }).eq('id', id);
  if (error) return showErr(error, '更新失败：');
  loadHomework();
}
async function delHw(id) {
  if (!confirm('确定删除这条作业？')) return;
  const { error } = await sb.from('homework').delete().eq('id', id);
  if (error) return showErr(error, '删除失败：');
  loadHomework();
}

// ============================================================
// 学习资料（文件夹树版本）
// ============================================================
let currentFolderId = 0;  // 当前所在文件夹ID，0 = 根目录
let materials = [];       // 所有资料缓存（含文件夹）

async function loadMaterials() {
  if (!courses.length) {
    const { data } = await sb.from('courses').select('*');
    courses = data || [];
  }
  fillCourseSelects();

  const { data, error } = await sb.from('materials').select('*').order('created_at', { ascending: false });
  if (error) return showErr(error, '加载资料失败：');
  materials = data || [];
  renderMaterials();
}

// 渲染当前文件夹内容
function renderMaterials() {
  renderFolderPath();
  const folders = materials.filter(m => m.is_folder && (m.parent_id || 0) === currentFolderId);
  const items = materials.filter(m => !m.is_folder && (m.parent_id || 0) === currentFolderId);

  const ul = document.getElementById('matList');
  const html = [
    ...folders.map(f => `
      <li class="item folder-item" onclick="navFolder(${f.id})">
        <div class="row1">
          <span class="title">📁 ${escapeHtml(f.name)}</span>
          <div class="ops">
            <button class="btn-del" onclick="event.stopPropagation(); delMat(${f.id})">删除</button>
          </div>
        </div>
        <div class="meta">文件夹（点击进入）</div>
      </li>
    `),
    ...items.map(m => `
      <li class="item">
        <div class="row1">
          <span class="title">${escapeHtml(m.name)}</span>
          <div class="ops">
            <button class="btn-del" onclick="delMat(${m.id})">删除</button>
          </div>
        </div>
        <div class="meta">
          <span class="tag">${escapeHtml(m.type || '其他')}</span>
          ${courseName(m.course_id) ? '<span class="tag">' + escapeHtml(courseName(m.course_id)) + '</span>' : ''}
          ${m.location ? '位置：' + escapeHtml(m.location) + '<br>' : ''}
          ${m.note ? '备注：' + escapeHtml(m.note) : ''}
        </div>
      </li>
    `)
  ];
  ul.innerHTML = html.length ? html.join('') : '<li class="empty">此文件夹为空，点上方「新建文件夹」或「添加资料」</li>';
}

// 渲染当前路径面包屑 + 返回按钮
function renderFolderPath() {
  let path = '根目录';
  if (currentFolderId !== 0) {
    const parts = [];
    let cur = materials.find(m => m.id === currentFolderId);
    while (cur) {
      parts.unshift(cur.name);
      cur = materials.find(m => m.id === (cur.parent_id || 0));
    }
    path = '根目录 / ' + parts.join(' / ');
  }
  const el = document.getElementById('folderPath');
  if (el) el.textContent = path;
  const back = document.getElementById('folderBack');
  if (back) back.style.display = currentFolderId === 0 ? 'none' : '';
}

// 进入文件夹
function navFolder(id) {
  currentFolderId = id;
  renderMaterials();
}

// 新建文件夹
async function openFolderForm() {
  const name = prompt('请输入文件夹名称：');
  if (!name) return;
  const { error } = await sb.from('materials').insert({
    name: name.trim(),
    is_folder: true,
    parent_id: currentFolderId
  });
  if (error) return showErr(error, '创建文件夹失败：');
  loadMaterials();
}

document.getElementById('matForm').addEventListener('submit', async e => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  body.is_folder = false;
  body.parent_id = currentFolderId;
  if (body.course_id === '') delete body.course_id;
  else body.course_id = Number(body.course_id);
  const { error } = await sb.from('materials').insert(body);
  if (error) return showErr(error, '保存失败：');
  e.target.reset();
  loadMaterials();
});

async function delMat(id) {
  const m = materials.find(x => x.id === id);
  const tip = m && m.is_folder ? '确定删除这个文件夹？文件夹内的资料不会被删除，但会变成根目录的内容。' : '确定删除这条资料？';
  if (!confirm(tip)) return;
  const { error } = await sb.from('materials').delete().eq('id', id);
  if (error) return showErr(error, '删除失败：');
  loadMaterials();
}

// ============================================================
// 日常琐事
// ============================================================
async function loadChores() {
  const { data, error } = await sb.from('chores').select('*').order('created_at', { ascending: false });
  if (error) return showErr(error, '加载琐事失败：');
  const list = data || [];

  const ul = document.getElementById('choreList');
  list.sort((a, b) => (a.done - b.done) || (a.due_date || '').localeCompare(b.due_date || ''));
  ul.innerHTML = list.length
    ? list.map(c => `
      <li class="item ${c.done ? 'is-done' : ''}">
        <div class="row1">
          <span class="title ${c.done ? 'done' : ''}">${escapeHtml(c.title)}</span>
          <div class="ops">
            <button class="btn-done ${c.done ? 'is-done' : ''}" onclick="toggleChore(${c.id}, ${!c.done})">${c.done ? '已做' : '完成'}</button>
            <button class="btn-del" onclick="delChore(${c.id})">删除</button>
          </div>
        </div>
        <div class="meta">${c.due_date ? '待办：' + escapeHtml(shortDate(c.due_date)) : ''}</div>
      </li>`).join('')
    : '<li class="empty">没有琐事记录</li>';
}

document.getElementById('choreForm').addEventListener('submit', async e => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  body.done = false;
  if (body.due_date === '') delete body.due_date;
  const { error } = await sb.from('chores').insert(body);
  if (error) return showErr(error, '保存失败：');
  e.target.reset();
  loadChores();
});

async function toggleChore(id, done) {
  const { error } = await sb.from('chores').update({ done }).eq('id', id);
  if (error) return showErr(error, '更新失败：');
  loadChores();
}
async function delChore(id) {
  if (!confirm('确定删除这条琐事？')) return;
  const { error } = await sb.from('chores').delete().eq('id', id);
  if (error) return showErr(error, '删除失败：');
  loadChores();
}

// ============================================================
// 给作业、资料表单的"所属课程"下拉框填充选项
// ============================================================
function fillCourseSelects() {
  const opts = '<option value="">（无）</option>' +
    courses.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  document.querySelectorAll('select[name="course_id"]').forEach(sel => {
    const cur = sel.value;
    sel.innerHTML = opts;
    sel.value = cur;
  });
}
