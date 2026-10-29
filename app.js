/**
 * 아이패드 백지테스트 애플리케이션 (app.js)
 * - HTML5 Canvas 고해상도 A4 벡터 스트로크 렌더링
 * - 2손가락 핀치 줌 (50%~300%) & 팬(이동) / 1손가락·펜슬 필기 분리
 * - 올가미(Lasso) 다각형 판정 및 이동/삭제
 * - 스마트 누적 타이머 (3분 무입력 자동 일시정지, 이탈 일시정지, 다시시작 누적 유지)
 * - Supabase + IndexedDB 오프라인 우선 동기화
 */

(() => {
  'use strict';

  // ==========================================
  // 1. 상태 관리 (State)
  // ==========================================
  const state = {
    // 세션 정보
    subject: '',
    lessonId: null,
    lessonName: '',

    // 도구: 'pen' | 'pencil' | 'highlighter' | 'eraser' | 'lasso'
    tool: 'pen',
    color: '#2D3748',
    strokeWidth: 3,
    showGrid: localStorage.getItem('blanktest_show_grid') === 'true',
    bgImage: null,

    // 스트로크 & 히스토리
    strokes: [],       // Array of Stroke objects
    undoStack: [],     // Undo snapshots
    redoStack: [],     // Redo snapshots

    // 올가미(Lasso) 상태
    lassoPoints: [],
    selectedStrokeIds: new Set(),
    lassoBBox: null,
    isDraggingLasso: false,
    dragStartPt: null,

    // 뷰포트 (Zoom & Pan)
    scale: 1,
    panX: 0,
    panY: 0,
    minScale: 0.5,
    maxScale: 3.0,

    // 타이머 상태
    timerSeconds: 0,
    timerRunning: false,
    timerInterval: null,
    lastActivityTime: Date.now(),
    inactivityLimitSec: 180, // 3분
    timerEverStarted: false,

    // 핀치 줌 / 멀티터치 트래킹
    pointers: new Map(),
    initialPinchDist: 0,
    initialPinchScale: 1,
    initialPan: { x: 0, y: 0 },
    initialMidpoint: { x: 0, y: 0 },
  };

  // ==========================================
  // 2. DOM 요소 참조
  // ==========================================
  const dom = {
    setupView: document.getElementById('setup-view'),
    canvasView: document.getElementById('canvas-view'),
    subjectSelect: document.getElementById('subject-select'),
    lessonSelect: document.getElementById('lesson-select'),
    startBtn: document.getElementById('start-test-btn'),
    openConfigBtn: document.getElementById('open-config-btn'),
    offlineBadge: document.getElementById('offline-badge-setup'),
    forceReloadBtn: document.getElementById('btn-force-reload'),

    // 캔버스 & 래퍼
    viewport: document.getElementById('canvas-container'),
    paperWrapper: document.getElementById('canvas-paper-wrapper'),
    bgCanvas: document.getElementById('bg-canvas'),
    paintCanvas: document.getElementById('paint-canvas'),
    overlayCanvas: document.getElementById('overlay-canvas'),
    zoomBadge: document.getElementById('zoom-badge'),

    // 상단 툴바
    backBtn: document.getElementById('back-to-setup-btn'),
    subjectLabel: document.getElementById('current-subject-label'),
    lessonLabel: document.getElementById('current-lesson-label'),
    timerBox: document.getElementById('timer-box'),
    timerDisplay: document.getElementById('timer-display'),
    timerStatus: document.getElementById('timer-status'),
    strokeWidthInput: document.getElementById('stroke-width'),
    strokeWidthVal: document.getElementById('stroke-width-val'),
    customColorInput: document.getElementById('custom-color'),

    // 도구 버튼
    toolPen: document.getElementById('tool-pen'),
    toolPencil: document.getElementById('tool-pencil'),
    toolHighlighter: document.getElementById('tool-highlighter'),
    toolEraser: document.getElementById('tool-eraser'),
    toolLasso: document.getElementById('tool-lasso'),
    undoBtn: document.getElementById('btn-undo'),
    redoBtn: document.getElementById('btn-redo'),
    gridBtn: document.getElementById('btn-grid'),
    btnBgImage: document.getElementById('btn-bg-image'),
    btnBgClear: document.getElementById('btn-bg-clear'),
    bgImageInput: document.getElementById('bg-image-input'),
    fitBtn: document.getElementById('btn-fit'),
    restartBtn: document.getElementById('btn-restart'),
    finishBtn: document.getElementById('btn-finish'),
    downloadBtn: document.getElementById('btn-download'),

    // 토스트 알림 컨테이너
    toastContainer: document.getElementById('toast-container'),

    // 올가미 액션 바
    lassoActionBar: document.getElementById('lasso-action-bar'),
    lassoDeleteBtn: document.getElementById('lasso-delete-btn'),
    lassoDeselectBtn: document.getElementById('lasso-deselect-btn'),

    // 점수 입력 모달
    scoreModal: document.getElementById('score-modal'),
    modalSubject: document.getElementById('modal-subject-text'),
    modalLesson: document.getElementById('modal-lesson-text'),
    modalDuration: document.getElementById('modal-duration-text'),
    scoreInput: document.getElementById('score-input'),
    modalCancelBtn: document.getElementById('modal-cancel-btn'),
    modalSubmitBtn: document.getElementById('modal-submit-btn'),

    // 설정 모달
    configModal: document.getElementById('config-modal'),
    cfgUrl: document.getElementById('cfg-supabase-url'),
    cfgKey: document.getElementById('cfg-supabase-key'),
    cfgCloseBtn: document.getElementById('cfg-close-btn'),
    cfgSaveBtn: document.getElementById('cfg-save-btn'),
  };

  // iOS 스타일 토스트 알림 함수
  let toastTimer = null;
  function showToast(message, duration = 3000) {
    if (!dom.toastContainer) return;
    dom.toastContainer.textContent = message;
    dom.toastContainer.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      dom.toastContainer.classList.remove('show');
    }, duration);
  }

  // iPad / iOS 감지 헬퍼
  function isAppleTouchDevice() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  const bgCtx = dom.bgCanvas ? dom.bgCanvas.getContext('2d') : null;
  const pCtx = dom.paintCanvas.getContext('2d');
  const oCtx = dom.overlayCanvas.getContext('2d');

  // ==========================================
  // 3. IndexedDB & Supabase 연동 (Offline First)
  // ==========================================
  const DB_NAME = 'BlankTest_OfflineDB';
  const STORE_NAME = 'pending_schedules';
  let idb = null;

  async function initIndexedDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = (e) => {
        idb = e.target.result;
        resolve(idb);
      };
      request.onerror = (e) => reject(e);
    });
  }

  async function savePendingSchedule(record) {
    if (!idb) await initIndexedDB();
    return new Promise((resolve, reject) => {
      const tx = idb.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e);
    });
  }

  async function getPendingSchedules() {
    if (!idb) await initIndexedDB();
    return new Promise((resolve) => {
      const tx = idb.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  async function deletePendingSchedule(id) {
    if (!idb) await initIndexedDB();
    return new Promise((resolve) => {
      const tx = idb.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  }

  // Supabase 클라이언트 초기화
  let supabase = null;
  function getSupabase() {
    if (supabase) return supabase;
    const defaultConfig = window.DEFAULT_SUPABASE_CONFIG || {};
    const url = localStorage.getItem('BLANK_SUPABASE_URL') || defaultConfig.url;
    const key = localStorage.getItem('BLANK_SUPABASE_KEY') || defaultConfig.key;
    if (url && key && window.supabase) {
      supabase = window.supabase.createClient(url, key);
    }
    return supabase;
  }

  // 오프라인 큐 동기화
  async function syncPendingSchedules() {
    if (!navigator.onLine) return;
    const client = getSupabase();
    if (!client) return;

    try {
      const pendingList = await getPendingSchedules();
      if (pendingList.length === 0) return;

      console.log(`[동기화] 대기 데이터 ${pendingList.length}건 동기화 시작`);
      for (const record of pendingList) {
        const { error } = await client.from('schedules').upsert(record);
        if (!error) {
          await deletePendingSchedule(record.id);
          console.log(`[동기화] 레코드 ${record.id} 업로드 성공 및 로컬 삭제`);
        } else {
          console.error('[동기화 실패]', error);
        }
      }
    } catch (err) {
      console.warn('[동기화 에러]', err);
    }
  }

  window.addEventListener('online', () => {
    updateOnlineBadge();
    syncPendingSchedules();
  });
  window.addEventListener('offline', updateOnlineBadge);

  function updateOnlineBadge() {
    if (navigator.onLine) {
      dom.offlineBadge.textContent = '온라인';
      dom.offlineBadge.className = 'badge';
    } else {
      dom.offlineBadge.textContent = '오프라인 (로컬 보관)';
      dom.offlineBadge.className = 'badge offline';
    }
  }

  // ==========================================
  // 4. 과목 & 단원 로드 (Supabase or Fallback)
  // ==========================================
  const fallbackData = [
    {
      name: '영어',
      lessons: [
        { id: 1, unit_name: '1과: The Part You Play' },
        { id: 2, unit_name: '2과: Science and Nature' },
        { id: 3, unit_name: '3과: Living Together' }
      ]
    },
    {
      name: '수학',
      lessons: [
        { id: 101, unit_name: '1단원: 다항식의 연산' },
        { id: 102, unit_name: '2단원: 이차방정식과 이차함수' }
      ]
    },
    {
      name: '통합과학',
      lessons: [
        { id: 201, unit_name: '1단원: 물질의 규칙성과 결합' },
        { id: 202, unit_name: '2단원: 시스템과 상호작용' }
      ]
    }
  ];

  let loadedSubjects = [];
  let loadedLessons = [];

  async function loadSubjectsAndLessons() {
    dom.subjectSelect.innerHTML = '<option value="">과목을 불러오는 중...</option>';
    const client = getSupabase();

    if (client) {
      try {
        const [subRes, lesRes] = await Promise.all([
          client.from('subjects').select('*').order('name'),
          client.from('lessons').select('*').order('id')
        ]);

        if (!subRes.error && subRes.data && subRes.data.length > 0) {
          loadedSubjects = subRes.data;
          loadedLessons = lesRes.data || [];
          renderSubjectOptions();
          return;
        }
      } catch (e) {
        console.warn('Supabase fetch failed, using fallback data', e);
      }
    }

    // Fallback Mockup Data
    loadedSubjects = fallbackData.map(d => ({ name: d.name }));
    loadedLessons = fallbackData.flatMap(d => d.lessons.map(l => ({ ...l, subject_name: d.name })));
    renderSubjectOptions();
  }

  function renderSubjectOptions() {
    dom.subjectSelect.innerHTML = '<option value="">과목을 선택하세요</option>' +
      loadedSubjects.map(s => `<option value="${s.name}">${s.name}</option>`).join('');
    dom.lessonSelect.innerHTML = '<option value="">과목을 먼저 선택하세요</option>';
    dom.lessonSelect.disabled = true;
    dom.startBtn.disabled = true;
  }

  dom.subjectSelect.addEventListener('change', (e) => {
    const selectedSub = e.target.value;
    state.subject = selectedSub;

    if (!selectedSub) {
      dom.lessonSelect.innerHTML = '<option value="">과목을 먼저 선택하세요</option>';
      dom.lessonSelect.disabled = true;
      dom.startBtn.disabled = true;
      return;
    }

    const filtered = loadedLessons.filter(l => l.subject_name === selectedSub);
    if (filtered.length === 0) {
      dom.lessonSelect.innerHTML = '<option value="">등록된 단원이 없습니다</option>';
      dom.lessonSelect.disabled = true;
      dom.startBtn.disabled = true;
    } else {
      dom.lessonSelect.innerHTML = '<option value="">단원을 선택하세요</option>' +
        filtered.map(l => `<option value="${l.id}">${l.unit_name}</option>`).join('');
      dom.lessonSelect.disabled = false;
      dom.startBtn.disabled = true;
    }
  });

  dom.lessonSelect.addEventListener('change', (e) => {
    const val = e.target.value;
    state.lessonId = val ? Number(val) : null;
    const selectedOpt = dom.lessonSelect.options[dom.lessonSelect.selectedIndex];
    state.lessonName = selectedOpt ? selectedOpt.text : '';
    dom.startBtn.disabled = !val;
  });

  // 시작 버튼
  dom.startBtn.addEventListener('click', () => {
    dom.subjectLabel.textContent = state.subject;
    dom.lessonLabel.textContent = state.lessonName;
    dom.setupView.classList.remove('active');
    dom.canvasView.classList.add('active');

    // 화면 진입 시 가로 사이즈 기준 화면 맞춤
    fitToWidth();
    resetSession(false); // 타이머는 0으로 시작 준비
  });

  dom.backBtn.addEventListener('click', () => {
    if (state.strokes.length > 0) {
      if (!confirm('진행 중인 테스트가 있습니다. 나가시겠습니까? (내용은 저장되지 않습니다)')) {
        return;
      }
    }
    stopTimer();
    dom.canvasView.classList.remove('active');
    dom.setupView.classList.add('active');
  });

  // ==========================================
  // 5. 캔버스 뷰포트 제어 (Zoom & Pan, 화면 맞춤)
  // ==========================================
  function updateViewportTransform() {
    dom.paperWrapper.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.scale})`;
    dom.zoomBadge.textContent = `${Math.round(state.scale * 100)}%`;
    updateLassoActionBarPos();
  }

  // 가로 사이즈(폭) 기준으로 캔버스 크기 및 위치 맞춤
  function fitToWidth() {
    if (!dom.canvasView.classList.contains('active')) return;

    const vpW = dom.viewport.clientWidth;
    if (!vpW) return;
    const paperW = dom.paintCanvas.width;

    // 좌우 여백 (패딩 32px)
    const padding = 32;
    let s = (vpW - padding) / paperW;
    s = Math.max(state.minScale, Math.min(state.maxScale, s));

    state.scale = s;
    state.panX = (vpW - paperW * s) / 2;
    state.panY = 75; // 상단 플로팅 툴바 아래 여백 배치
    updateViewportTransform();
  }

  dom.fitBtn.addEventListener('click', fitToWidth);

  // 화면 회전 및 리사이즈 감지 시 가로 사이즈 기준 자동 맞춤
  let resizeTimer = null;
  function handleScreenChange() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      fitToWidth();
    }, 100);
  }
  window.addEventListener('resize', handleScreenChange);
  window.addEventListener('orientationchange', handleScreenChange);

  // 뷰포트 화면 좌표 -> 캔버스 내부 논리 좌표 변환
  function clientToCanvas(clientX, clientY) {
    const rect = dom.paperWrapper.getBoundingClientRect();
    const x = (clientX - rect.left) / state.scale;
    const y = (clientY - rect.top) / state.scale;
    return { x, y };
  }

  // ==========================================
  // 6. 스마트 타이머 & 비활동 감지 로직
  // ==========================================
  function formatTime(seconds) {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  function startTimer() {
    if (state.timerRunning) return;
    state.timerRunning = true;
    state.timerEverStarted = true;
    state.lastActivityTime = Date.now();
    dom.timerBox.className = 'timer-box running';
    dom.timerStatus.textContent = '측정 중';

    if (state.timerInterval) clearInterval(state.timerInterval);
    state.timerInterval = setInterval(() => {
      // 3분(180초) 비활동 체크
      const inactiveSec = (Date.now() - state.lastActivityTime) / 1000;
      if (inactiveSec >= state.inactivityLimitSec) {
        pauseTimer('3분 미동작 일시정지');
        return;
      }

      state.timerSeconds++;
      dom.timerDisplay.textContent = formatTime(state.timerSeconds);
    }, 1000);
  }

  function pauseTimer(reason = '일시정지') {
    if (!state.timerRunning) return;
    state.timerRunning = false;
    clearInterval(state.timerInterval);
    state.timerInterval = null;
    dom.timerBox.className = 'timer-box paused';
    dom.timerStatus.textContent = reason;
  }

  function stopTimer() {
    state.timerRunning = false;
    clearInterval(state.timerInterval);
    state.timerInterval = null;
    dom.timerBox.className = 'timer-box';
    dom.timerStatus.textContent = '대기 중';
  }

  function registerUserActivity() {
    state.lastActivityTime = Date.now();
    if (!state.timerRunning && state.canvasViewActive()) {
      startTimer();
    }
  }

  state.canvasViewActive = () => dom.canvasView.classList.contains('active');

  // 화면 이탈 / 백그라운드 전환 감지
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      pauseTimer('화면 이탈 일시정지');
    }
  });
  window.addEventListener('blur', () => {
    pauseTimer('화면 이탈 일시정지');
  });

  // 처음부터 다시 쓰기 (누적 시간은 리셋하지 않고 보존)
  dom.restartBtn.addEventListener('click', () => {
    if (confirm('현재 필기 내용을 지우고 처음부터 다시 시작하시겠습니까?\n(측정 시간은 초기화되지 않고 유지됩니다)')) {
      pushUndoAction({ type: 'clear', prevStrokes: state.strokes.slice() });
      state.strokes = [];
      state.selectedStrokeIds.clear();
      state.lassoBBox = null;
      hideLassoActionBar();
      redrawAll();
      clearOverlay();
      pauseTimer('재시작 준비');
    }
  });

  // ==========================================
  // 7. 벡터 스트로크 및 렌더링 엔진
  // ==========================================
  let currentStroke = null;

  // 캔버스 드로잉 스타일을 스트로크 시작 시 1회만 설정 (save/restore 오버헤드 제거)
  function setupPaintContextStyle(stroke) {
    pCtx.lineCap = 'round';
    pCtx.lineJoin = 'round';
    if (stroke.type === 'highlighter') {
      pCtx.globalAlpha = 0.35;
      pCtx.strokeStyle = stroke.color;
      pCtx.lineWidth = stroke.width * 3.5;
    } else if (stroke.type === 'pencil') {
      pCtx.globalAlpha = 0.65;
      pCtx.strokeStyle = stroke.color;
      pCtx.lineWidth = Math.max(1, stroke.width * 0.9);
    } else {
      pCtx.globalAlpha = 1.0;
      pCtx.strokeStyle = stroke.color;
      pCtx.lineWidth = stroke.width;
    }
  }

  // 스트로크 좌표 오프셋 이동 (올가미 이동용)
  function applyStrokeMove(ids, dx, dy) {
    const idSet = ids instanceof Set ? ids : new Set(ids);
    for (const stroke of state.strokes) {
      if (idSet.has(stroke.id)) {
        for (const p of stroke.points) {
          p.x += dx;
          p.y += dy;
        }
        stroke.bbox.minX += dx;
        stroke.bbox.maxX += dx;
        stroke.bbox.minY += dy;
        stroke.bbox.maxY += dy;
      }
    }
  }

  // 액션 기반 초경량 Undo / Redo 스택 (객체 통복사 제거로 0ms 초고속 동작)
  function pushUndoAction(action) {
    state.undoStack.push(action);
    if (state.undoStack.length > 50) state.undoStack.shift();
    state.redoStack = []; // 새 작업 시 redo 초기화
  }

  function pushUndoSnapshot() {
    // 하위 호환용 스냅샷 래퍼
    pushUndoAction({ type: 'replace', prevStrokes: state.strokes.slice(), nextStrokes: state.strokes.slice() });
  }

  function triggerUndo() {
    if (state.undoStack.length === 0) return;
    const action = state.undoStack.pop();

    if (action.type === 'add') {
      const idx = state.strokes.indexOf(action.stroke);
      if (idx !== -1) state.strokes.splice(idx, 1);
      state.redoStack.push(action);
    } else if (action.type === 'erase' || action.type === 'delete' || action.type === 'clear') {
      state.redoStack.push(action);
      state.strokes = action.prevStrokes.slice();
    } else if (action.type === 'move') {
      applyStrokeMove(action.ids, -action.dx, -action.dy);
      state.redoStack.push(action);
    } else if (action.type === 'replace') {
      state.redoStack.push(action);
      state.strokes = action.prevStrokes.slice();
    }

    state.selectedStrokeIds.clear();
    state.lassoBBox = null;
    hideLassoActionBar();
    redrawAll();
    clearOverlay();
    registerUserActivity();
    showToast('실행 취소 (Undo)', 1200);
  }

  dom.undoBtn.addEventListener('click', triggerUndo);

  function triggerRedo() {
    if (state.redoStack.length === 0) return;
    const action = state.redoStack.pop();

    if (action.type === 'add') {
      state.strokes.push(action.stroke);
      state.undoStack.push(action);
    } else if (action.type === 'erase' || action.type === 'delete') {
      state.undoStack.push(action);
      state.strokes = action.nextStrokes.slice();
    } else if (action.type === 'clear') {
      state.undoStack.push(action);
      state.strokes = [];
    } else if (action.type === 'move') {
      applyStrokeMove(action.ids, action.dx, action.dy);
      state.undoStack.push(action);
    } else if (action.type === 'replace') {
      state.undoStack.push(action);
      state.strokes = action.nextStrokes.slice();
    }

    state.selectedStrokeIds.clear();
    state.lassoBBox = null;
    hideLassoActionBar();
    redrawAll();
    clearOverlay();
    registerUserActivity();
  }

  dom.redoBtn.addEventListener('click', triggerRedo);

  function computeBBox(points) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  }

  function redrawAll() {
    pCtx.clearRect(0, 0, dom.paintCanvas.width, dom.paintCanvas.height);

    for (const stroke of state.strokes) {
      drawSingleStroke(pCtx, stroke);
    }
  }

  function drawSingleStroke(ctx, stroke) {
    if (!stroke.points || stroke.points.length === 0) return;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (stroke.type === 'highlighter') {
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width * 3.5;
    } else if (stroke.type === 'pencil') {
      ctx.globalAlpha = 0.65;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = Math.max(1, stroke.width * 0.9);
    } else {
      ctx.globalAlpha = 1.0;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
    }

    ctx.beginPath();
    const pts = stroke.points;
    if (pts.length === 1) {
      const radius = (stroke.type === 'pencil') ? Math.max(0.6, (stroke.width * 0.9) / 2) : stroke.width / 2;
      ctx.arc(pts[0].x, pts[0].y, radius, 0, Math.PI * 2);
      ctx.fillStyle = stroke.color;
      ctx.fill();
    } else {
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        // 부드러운 곡선 렌더링 (Quad Bézier)
        const midX = (pts[i - 1].x + pts[i].x) / 2;
        const midY = (pts[i - 1].y + pts[i].y) / 2;
        ctx.quadraticCurveTo(pts[i - 1].x, pts[i - 1].y, midX, midY);
      }
      ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ==========================================
  // 8. 올가미(Lasso) 알고리즘 (Ray-casting)
  // ==========================================
  // 점이 다각형 내부에 있는지 검사하는 Ray-casting 알고리즘
  function isPointInPolygon(point, vs) {
    let x = point.x, y = point.y;
    let inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
      let xi = vs[i].x, yi = vs[i].y;
      let xj = vs[j].x, yj = vs[j].y;
      let intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function evaluateLassoSelection() {
    if (state.lassoPoints.length < 3) return;

    state.selectedStrokeIds.clear();

    for (const stroke of state.strokes) {
      // 스트로크의 중간점 또는 주요 지점들이 올가미 내부에 들어있는지 판정
      let insideCount = 0;
      const step = Math.max(1, Math.floor(stroke.points.length / 5));
      for (let i = 0; i < stroke.points.length; i += step) {
        if (isPointInPolygon(stroke.points[i], state.lassoPoints)) {
          insideCount++;
        }
      }

      if (insideCount > 0) {
        state.selectedStrokeIds.add(stroke.id);
      }
    }

    if (state.selectedStrokeIds.size > 0) {
      computeSelectedBBox();
      renderSelectionOverlay();
      showLassoActionBar();
    } else {
      state.lassoBBox = null;
      hideLassoActionBar();
      clearOverlay();
    }
  }

  function computeSelectedBBox() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of state.strokes) {
      if (state.selectedStrokeIds.has(s.id)) {
        if (s.bbox.minX < minX) minX = s.bbox.minX;
        if (s.bbox.minY < minY) minY = s.bbox.minY;
        if (s.bbox.maxX > maxX) maxX = s.bbox.maxX;
        if (s.bbox.maxY > maxY) maxY = s.bbox.maxY;
      }
    }
    const pad = 12;
    state.lassoBBox = {
      minX: minX - pad,
      minY: minY - pad,
      maxX: maxX + pad,
      maxY: maxY + pad,
      width: (maxX - minX) + pad * 2,
      height: (maxY - minY) + pad * 2
    };
  }

  function renderSelectionOverlay() {
    clearOverlay();
    if (!state.lassoBBox) return;

    const b = state.lassoBBox;
    oCtx.save();
    // 바운딩 박스
    oCtx.strokeStyle = '#3b82f6';
    oCtx.lineWidth = 2;
    oCtx.setLineDash([8, 6]);
    oCtx.strokeRect(b.minX, b.minY, b.width, b.height);

    // 내부 연한 하이라이트
    oCtx.fillStyle = 'rgba(59, 130, 246, 0.08)';
    oCtx.fillRect(b.minX, b.minY, b.width, b.height);

    // 모서리 핸들
    oCtx.setLineDash([]);
    oCtx.fillStyle = '#ffffff';
    oCtx.strokeStyle = '#2563eb';
    oCtx.lineWidth = 2;
    const handles = [
      { x: b.minX, y: b.minY },
      { x: b.maxX, y: b.minY },
      { x: b.minX, y: b.maxY },
      { x: b.maxX, y: b.maxY }
    ];
    for (const h of handles) {
      oCtx.beginPath();
      oCtx.arc(h.x, h.y, 6, 0, Math.PI * 2);
      oCtx.fill();
      oCtx.stroke();
    }
    oCtx.restore();
    updateLassoActionBarPos();
  }

  function clearOverlay() {
    oCtx.clearRect(0, 0, dom.overlayCanvas.width, dom.overlayCanvas.height);
  }

  function showLassoActionBar() {
    dom.lassoActionBar.classList.remove('hidden');
    updateLassoActionBarPos();
  }

  function hideLassoActionBar() {
    dom.lassoActionBar.classList.add('hidden');
  }

  function updateLassoActionBarPos() {
    if (!state.lassoBBox || dom.lassoActionBar.classList.contains('hidden')) return;

    // 캔버스 좌표 -> 뷰포트 화면 좌표 변환
    const rect = dom.paperWrapper.getBoundingClientRect();
    const centerX = rect.left + ((state.lassoBBox.minX + state.lassoBBox.width / 2) * state.scale);
    const topY = rect.top + (state.lassoBBox.minY * state.scale);

    dom.lassoActionBar.style.left = `${centerX}px`;
    dom.lassoActionBar.style.top = `${topY}px`;
  }

  // 올가미 선택 스트로크 삭제
  dom.lassoDeleteBtn.addEventListener('click', () => {
    if (state.selectedStrokeIds.size === 0) return;
    const prev = state.strokes.slice();
    const next = state.strokes.filter(s => !state.selectedStrokeIds.has(s.id));
    pushUndoAction({ type: 'delete', prevStrokes: prev, nextStrokes: next });
    state.strokes = next;
    state.selectedStrokeIds.clear();
    state.lassoBBox = null;
    hideLassoActionBar();
    clearOverlay();
    redrawAll();
    registerUserActivity();
  });

  // 올가미 선택 해제
  dom.lassoDeselectBtn.addEventListener('click', () => {
    state.selectedStrokeIds.clear();
    state.lassoBBox = null;
    hideLassoActionBar();
    clearOverlay();
  });

  // ==========================================
  // 9. 포인터 입력 & 제스처 (iPad Touch/Pencil 처리)
  // ==========================================
  dom.viewport.addEventListener('pointerdown', onPointerDown);
  dom.viewport.addEventListener('pointermove', onPointerMove);
  dom.viewport.addEventListener('pointerup', onPointerUp);
  dom.viewport.addEventListener('pointercancel', onPointerUp);

  let twoFingerTapInfo = null;

  function onPointerDown(e) {
    e.preventDefault();
    dom.viewport.setPointerCapture(e.pointerId);

    const isPen = (e.pointerType === 'pen');

    // 1. 펜 입력 최우선 처리: 2손가락 제스처 판정 및 팜터치 무시하고 즉시 필기 직행
    if (isPen) {
      registerUserActivity();
      state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, isPen: true });
      startSinglePointerAction(e, true);
      return;
    }

    // 2. 손가락 터치(touch)인 경우:
    // 만약 펜으로 필기 중이라면, 손바닥 터치는 무시 (Palm Rejection)
    if (currentStroke && currentStroke.isPen) {
      return;
    }

    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, isPen: false });
    registerUserActivity();

    // 두 손가락 이상: 줌 & 팬 모드 진입 및 2손가락 탭 감지 시작
    if (state.pointers.size === 2) {
      if (currentStroke) {
        currentStroke = null;
        redrawAll();
      }
      state.lassoPoints = [];
      clearOverlay();

      const pts = Array.from(state.pointers.values());
      state.initialPinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      state.initialPinchScale = state.scale;
      state.initialPan = { x: state.panX, y: state.panY };
      state.initialMidpoint = {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2
      };

      twoFingerTapInfo = {
        startTime: Date.now(),
        startPts: pts.map(p => ({ x: p.x, y: p.y })),
        startPan: { x: state.panX, y: state.panY },
        startScale: state.scale,
        moved: false
      };
      return;
    }

    // 1개 포인터 (손가락 터치 필기/올가미/지우개)
    if (state.pointers.size === 1) {
      startSinglePointerAction(e, false);
    }
  }

  function startSinglePointerAction(e, isPen) {
    const pt = clientToCanvas(e.clientX, e.clientY);

    // 올가미 선택 영역 내부 드래그인지 확인
    if (state.tool === 'lasso' && state.lassoBBox) {
      const b = state.lassoBBox;
      if (pt.x >= b.minX && pt.x <= b.maxX && pt.y >= b.minY && pt.y <= b.maxY) {
        state.isDraggingLasso = true;
        state.dragStartPt = pt;
        state.lassoTotalDelta = { dx: 0, dy: 0 };
        return;
      } else {
        // 외부 탭 시 기존 선택 해제 후 새로 그리기
        state.selectedStrokeIds.clear();
        state.lassoBBox = null;
        hideLassoActionBar();
        clearOverlay();
      }
    }

    if (state.tool === 'pen' || state.tool === 'pencil' || state.tool === 'highlighter') {
      currentStroke = {
        id: 's_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        type: state.tool,
        color: state.color,
        width: Number(state.strokeWidth),
        points: [pt],
        bbox: { minX: pt.x, minY: pt.y, maxX: pt.x, maxY: pt.y },
        isPen: isPen
      };
      setupPaintContextStyle(currentStroke);
      drawSingleStroke(pCtx, currentStroke);
    } else if (state.tool === 'eraser') {
      eraseAtPoint(pt);
    } else if (state.tool === 'lasso') {
      state.lassoPoints = [pt];
      clearOverlay();
    }
  }

  function onPointerMove(e) {
    if (!state.pointers.has(e.pointerId)) return;
    e.preventDefault();
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, isPen: (e.pointerType === 'pen') });

    const isPen = (e.pointerType === 'pen');

    // 펜 입력이거나 펜 필기 중인 경우: 핀치 줌 로직 완전 스킵하고 100% 드로잉 직행
    if (isPen || (currentStroke && currentStroke.isPen)) {
      if (isPen) {
        handleSinglePointerMove(e);
      }
      return;
    }

    // 멀티터치 제스처 (2손가락 핀치 줌 & 팬)
    if (state.pointers.size === 2) {
      const pts = Array.from(state.pointers.values());
      const currentDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const currentMid = {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2
      };

      if (twoFingerTapInfo && !twoFingerTapInfo.moved) {
        for (let i = 0; i < pts.length; i++) {
          const s = twoFingerTapInfo.startPts[i];
          if (s && Math.hypot(pts[i].x - s.x, pts[i].y - s.y) > 12) {
            twoFingerTapInfo.moved = true;
            break;
          }
        }
      }

      if (state.initialPinchDist > 0) {
        const factor = currentDist / state.initialPinchDist;
        let newScale = state.initialPinchScale * factor;
        newScale = Math.max(state.minScale, Math.min(state.maxScale, newScale));

        // 핀치 중심 기준 줌
        const scaleDiff = newScale - state.scale;
        state.panX -= (currentMid.x - state.panX) * (scaleDiff / state.scale);
        state.panY -= (currentMid.y - state.panY) * (scaleDiff / state.scale);
        state.scale = newScale;

        // 드래그 팬
        state.panX += (currentMid.x - state.initialMidpoint.x) * 0.5;
        state.panY += (currentMid.y - state.initialMidpoint.y) * 0.5;
        state.initialMidpoint = currentMid;

        updateViewportTransform();
      }
      return;
    }

    // 단일 포인터 동작
    if (state.pointers.size === 1) {
      handleSinglePointerMove(e);
    }
  }

  function handleSinglePointerMove(e) {
    // 2초마다 사용자 활동 등록 스로틀링 (매 move 호출 부담 제거)
    if (Date.now() - state.lastActivityTime > 2000) {
      registerUserActivity();
    }

    const pt = clientToCanvas(e.clientX, e.clientY);

    // 올가미 드래그 이동
    if (state.isDraggingLasso && state.dragStartPt) {
      const dx = pt.x - state.dragStartPt.x;
      const dy = pt.y - state.dragStartPt.y;
      state.dragStartPt = pt;
      if (!state.lassoTotalDelta) state.lassoTotalDelta = { dx: 0, dy: 0 };
      state.lassoTotalDelta.dx += dx;
      state.lassoTotalDelta.dy += dy;

      applyStrokeMove(state.selectedStrokeIds, dx, dy);
      computeSelectedBBox();
      redrawAll();
      renderSelectionOverlay();
      return;
    }

    // 펜 / 연필 / 형광펜 그리기 (Apple Pencil 120Hz/240Hz 핫패스 최적화)
    if (currentStroke) {
      const rawEvents = (e.getCoalescedEvents && e.getCoalescedEvents().length > 0)
        ? e.getCoalescedEvents()
        : [e];

      for (let i = 0; i < rawEvents.length; i++) {
        const ev = rawEvents[i];
        const movePt = clientToCanvas(ev.clientX, ev.clientY);
        const pts = currentStroke.points;
        const prevPt = pts[pts.length - 1];

        if (prevPt && prevPt.x === movePt.x && prevPt.y === movePt.y) continue;

        pts.push(movePt);

        if (movePt.x < currentStroke.bbox.minX) currentStroke.bbox.minX = movePt.x;
        if (movePt.y < currentStroke.bbox.minY) currentStroke.bbox.minY = movePt.y;
        if (movePt.x > currentStroke.bbox.maxX) currentStroke.bbox.maxX = movePt.x;
        if (movePt.y > currentStroke.bbox.maxY) currentStroke.bbox.maxY = movePt.y;

        // save/restore 없이 경량화된 즉각 선분 렌더링
        pCtx.beginPath();
        pCtx.moveTo(prevPt.x, prevPt.y);
        pCtx.lineTo(movePt.x, movePt.y);
        pCtx.stroke();
      }
    } else if (state.tool === 'eraser') {
      eraseAtPoint(pt);
    } else if (state.tool === 'lasso' && state.lassoPoints.length > 0) {
      state.lassoPoints.push(pt);
      clearOverlay();
      oCtx.save();
      oCtx.strokeStyle = '#3b82f6';
      oCtx.lineWidth = 2;
      oCtx.setLineDash([6, 6]);
      oCtx.beginPath();
      oCtx.moveTo(state.lassoPoints[0].x, state.lassoPoints[0].y);
      for (let i = 1; i < state.lassoPoints.length; i++) {
        oCtx.lineTo(state.lassoPoints[i].x, state.lassoPoints[i].y);
      }
      oCtx.stroke();
      oCtx.restore();
    }
  }

  function onPointerUp(e) {
    if (twoFingerTapInfo) {
      const elapsed = Date.now() - twoFingerTapInfo.startTime;
      if (!twoFingerTapInfo.moved && elapsed < 350) {
        state.panX = twoFingerTapInfo.startPan.x;
        state.panY = twoFingerTapInfo.startPan.y;
        state.scale = twoFingerTapInfo.startScale;
        updateViewportTransform();
        triggerUndo();
      }
      twoFingerTapInfo = null;
    }

    if (state.pointers.has(e.pointerId)) {
      state.pointers.delete(e.pointerId);
      try {
        dom.viewport.releasePointerCapture(e.pointerId);
      } catch (err) { }
    }

    if (state.pointers.size === 0) {
      twoFingerTapInfo = null;
    }

    if (state.isDraggingLasso) {
      state.isDraggingLasso = false;
      state.dragStartPt = null;
      if (state.lassoTotalDelta && (state.lassoTotalDelta.dx !== 0 || state.lassoTotalDelta.dy !== 0)) {
        pushUndoAction({
          type: 'move',
          ids: Array.from(state.selectedStrokeIds),
          dx: state.lassoTotalDelta.dx,
          dy: state.lassoTotalDelta.dy
        });
      }
      return;
    }

    if (currentStroke) {
      pushUndoAction({ type: 'add', stroke: currentStroke });
      state.strokes.push(currentStroke);
      currentStroke = null;
      // 최적화: pointerup 시 캔버스 전량 재렌더링(redrawAll)을 제거하여 획 종료 딜레이 완전 박멸
    }

    if (state.tool === 'lasso' && state.lassoPoints.length > 2) {
      evaluateLassoSelection();
      state.lassoPoints = [];
    }
  }

  // 지우개 처리 (획 지우개)
  function eraseAtPoint(pt) {
    const radius = 15;
    let erasedAny = false;

    const remaining = [];
    for (const stroke of state.strokes) {
      let hit = false;
      for (const p of stroke.points) {
        if (Math.hypot(p.x - pt.x, p.y - pt.y) <= radius) {
          hit = true;
          break;
        }
      }
      if (hit) {
        erasedAny = true;
      } else {
        remaining.push(stroke);
      }
    }

    if (erasedAny) {
      const prev = state.strokes.slice();
      state.strokes = remaining;
      pushUndoAction({
        type: 'erase',
        prevStrokes: prev,
        nextStrokes: remaining
      });
      redrawAll();
    }
  }

  // ==========================================
  // 10. 도구 및 스타일 전환
  // ==========================================
  const toolButtons = [
    { btn: dom.toolPen, tool: 'pen' },
    { btn: dom.toolPencil, tool: 'pencil' },
    { btn: dom.toolHighlighter, tool: 'highlighter' },
    { btn: dom.toolEraser, tool: 'eraser' },
    { btn: dom.toolLasso, tool: 'lasso' }
  ];

  function setActiveTool(newTool) {
    state.tool = newTool;
    toolButtons.forEach(({ btn, tool }) => {
      if (btn) btn.classList.toggle('active', tool === newTool);
    });

    if (newTool !== 'lasso') {
      state.selectedStrokeIds.clear();
      state.lassoBBox = null;
      hideLassoActionBar();
      clearOverlay();
    }
  }

  toolButtons.forEach(({ btn, tool }) => {
    if (btn) btn.addEventListener('click', () => setActiveTool(tool));
  });

  // 모눈종이(Grid) 토글 리스너 및 초기화
  if (dom.gridBtn) {
    if (state.showGrid) {
      dom.paperWrapper.classList.add('has-grid');
      dom.gridBtn.classList.add('active');
    }
    dom.gridBtn.addEventListener('click', () => {
      state.showGrid = !state.showGrid;
      dom.paperWrapper.classList.toggle('has-grid', state.showGrid);
      dom.gridBtn.classList.toggle('active', state.showGrid);
      localStorage.setItem('blanktest_show_grid', String(state.showGrid));
      showToast(state.showGrid ? '모눈종이 활성화 📐' : '모눈종이 해제', 1200);
    });
  }

  // 시작 화면 최신 버전 강제 새로고침 (PWA / 브라우저 캐시 삭제)
  if (dom.forceReloadBtn) {
    dom.forceReloadBtn.addEventListener('click', async () => {
      showToast('최신 버전을 확인하고 새로고침 중...', 3000);
      try {
        if ('serviceWorker' in navigator) {
          const registrations = await navigator.serviceWorker.getRegistrations();
          for (const reg of registrations) {
            await reg.unregister();
          }
        }
        if ('caches' in window) {
          const cacheNames = await caches.keys();
          await Promise.all(cacheNames.map(name => caches.delete(name)));
        }
      } catch (err) {
        console.warn('캐시 초기화 중 오류:', err);
      }
      const cleanUrl = window.location.origin + window.location.pathname;
      window.location.replace(`${cleanUrl}?v=${Date.now()}`);
    });
  }

  // 배경 이미지 용지 맞춤 렌더링 함수
  function drawBackgroundImage(img) {
    if (!bgCtx || !dom.bgCanvas) return;
    bgCtx.clearRect(0, 0, dom.bgCanvas.width, dom.bgCanvas.height);
    if (!img) return;

    const cw = dom.bgCanvas.width;   // 1754
    const ch = dom.bgCanvas.height;  // 2480

    // 원본 비율을 유지하며 A4 용지 안에 꽉 차게 중앙 정렬(contain fit)
    const scale = Math.min(cw / img.width, ch / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    const dx = (cw - dw) / 2;
    const dy = (ch - dh) / 2;

    bgCtx.drawImage(img, dx, dy, dw, dh);
  }

  function clearBackgroundImage() {
    if (bgCtx && dom.bgCanvas) {
      bgCtx.clearRect(0, 0, dom.bgCanvas.width, dom.bgCanvas.height);
    }
    state.bgImage = null;
    if (dom.bgImageInput) dom.bgImageInput.value = '';
    if (dom.btnBgClear) dom.btnBgClear.classList.add('hidden');
  }

  // 배경 이미지 선택 & 제거 리스너
  if (dom.btnBgImage && dom.bgImageInput) {
    dom.btnBgImage.addEventListener('click', () => {
      dom.bgImageInput.click();
    });

    dom.bgImageInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          drawBackgroundImage(img);
          state.bgImage = img;
          if (dom.btnBgClear) dom.btnBgClear.classList.remove('hidden');
          showToast('배경 이미지가 용지에 맞게 적용되었습니다. 🖼️', 2500);
        };
        img.src = event.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  if (dom.btnBgClear) {
    dom.btnBgClear.addEventListener('click', () => {
      clearBackgroundImage();
      showToast('배경 이미지가 제거되었습니다.', 1800);
    });
  }

  // 색상 팔레트 클릭
  document.querySelectorAll('.color-dot').forEach(dot => {
    dot.addEventListener('click', (e) => {
      document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
      dot.classList.add('active');
      state.color = dot.dataset.color;
      dom.customColorInput.value = state.color;
      if (state.tool === 'eraser') setActiveTool('pen');
    });
  });

  dom.customColorInput.addEventListener('input', (e) => {
    state.color = e.target.value;
    document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
    if (state.tool === 'eraser') setActiveTool('pen');
  });

  // 선 굵기
  dom.strokeWidthInput.addEventListener('input', (e) => {
    state.strokeWidth = Number(e.target.value);
    dom.strokeWidthVal.textContent = `${state.strokeWidth}px`;
  });

  // ==========================================
  // 11. 테스트 완료, 점수 등록, 이미지 저장 & DB 연동
  // ==========================================
  dom.finishBtn.addEventListener('click', () => {
    pauseTimer('테스트 완료 검토');
    dom.modalSubject.textContent = state.subject;
    dom.modalLesson.textContent = state.lessonName;
    dom.modalDuration.textContent = `${Math.floor(state.timerSeconds / 60)}분 ${state.timerSeconds % 60}초`;
    dom.scoreInput.value = '';
    dom.scoreModal.classList.remove('hidden');
    dom.scoreInput.focus();
  });

  dom.modalCancelBtn.addEventListener('click', () => {
    dom.scoreModal.classList.add('hidden');
    startTimer();
  });

  dom.modalSubmitBtn.addEventListener('click', async () => {
    const scoreVal = dom.scoreInput.value.trim();
    if (!scoreVal) {
      alert('획득 점수를 입력해주세요 (예: 95 또는 95/100)');
      dom.scoreInput.focus();
      return;
    }

    dom.modalSubmitBtn.disabled = true;
    dom.modalSubmitBtn.textContent = '저장 중...';

    try {
      // 1. 고해상도 이미지 파일 생성 및 앨범/다운로드 저장
      await exportAndSaveCanvasImage();

      // 2. schedules 레코드 객체 생성
      const now = new Date();
      const dateStr = now.toISOString().split('T')[0];
      const durationSec = state.timerSeconds;
      const recordId = `blank_${Date.now()}`;

      const scheduleRecord = {
        id: recordId,
        lesson_id: state.lessonId,
        subject: state.subject,
        date: dateStr,
        category: '진도계획',
        title: `[백지테스트] ${state.subject} - ${state.lessonName}`,
        detail: `측정시간: ${Math.floor(durationSec / 60)}분 ${durationSec % 60}초`,
        progress: 100,
        score: scoreVal,
        duration_sec: durationSec,
        completed: true,
        updated_at: now.toISOString()
      };

      // 3. 온라인 / 오프라인 분기 처리
      if (navigator.onLine && getSupabase()) {
        const { error } = await getSupabase().from('schedules').insert(scheduleRecord);
        if (error) {
          console.warn('Supabase 직접 등록 실패, 로컬 큐에 저장:', error);
          await savePendingSchedule(scheduleRecord);
        } else {
          console.log('Supabase schedules 등록 완료:', scheduleRecord);
        }
      } else {
        // 오프라인 상태: 로컬 IndexedDB에 보관
        await savePendingSchedule(scheduleRecord);
        console.log('오프라인: IndexedDB에 임시 보관 완료');
      }

      showToast('백지테스트가 성공적으로 완료되어 일정이 등록되었습니다.', 3500);
      dom.scoreModal.classList.add('hidden');

      // 세션 완전 초기화 후 메인 화면 복귀
      resetSession(true);
      dom.canvasView.classList.remove('active');
      dom.setupView.classList.add('active');

    } catch (err) {
      console.error('완료 저장 에러:', err);
      showToast('저장 중 문제가 발생했습니다: ' + err.message, 4000);
    } finally {
      dom.modalSubmitBtn.disabled = false;
      dom.modalSubmitBtn.textContent = '확인 및 저장';
    }
  });

  // 상단 툴바 다운로드 버튼 (확인창 없이 즉시 저장)
  if (dom.downloadBtn) {
    dom.downloadBtn.addEventListener('click', async () => {
      dom.downloadBtn.disabled = true;
      try {
        await exportAndSaveCanvasImage();
      } catch (err) {
        console.error('이미지 저장 오류:', err);
        showToast('이미지 저장 실패: ' + err.message, 3000);
      } finally {
        dom.downloadBtn.disabled = false;
      }
    });
  }

  // 캔버스 이미지 로컬 앨범/다운로드 저장 함수 (확인창 없이 즉시 저장)
  async function exportAndSaveCanvasImage() {
    return new Promise((resolve) => {
      // 흰색 종이 배경 + 모눈(켜져있을 시) + 필기 스트로크 오프스크린 합성
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = dom.paintCanvas.width;
      exportCanvas.height = dom.paintCanvas.height;
      const expCtx = exportCanvas.getContext('2d');

      // 1. 흰색 용지 배경
      expCtx.fillStyle = '#ffffff';
      expCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);

      // 1-1. 배경 이미지가 있으면 용지에 합성
      if (state.bgImage && dom.bgCanvas) {
        expCtx.drawImage(dom.bgCanvas, 0, 0);
      }

      // 2. 모눈종이 활성화 시 모눈 격자선 합성
      if (state.showGrid) {
        expCtx.save();
        const w = exportCanvas.width;
        const h = exportCanvas.height;

        // 서브 그리드 (32px)
        expCtx.strokeStyle = 'rgba(90, 110, 135, 0.08)';
        expCtx.lineWidth = 1;
        expCtx.beginPath();
        for (let x = 0; x <= w; x += 32) {
          expCtx.moveTo(x, 0); expCtx.lineTo(x, h);
        }
        for (let y = 0; y <= h; y += 32) {
          expCtx.moveTo(0, y); expCtx.lineTo(w, y);
        }
        expCtx.stroke();

        // 메인 그리드 (160px)
        expCtx.strokeStyle = 'rgba(90, 110, 135, 0.18)';
        expCtx.lineWidth = 1.5;
        expCtx.beginPath();
        for (let x = 0; x <= w; x += 160) {
          expCtx.moveTo(x, 0); expCtx.lineTo(x, h);
        }
        for (let y = 0; y <= h; y += 160) {
          expCtx.moveTo(0, y); expCtx.lineTo(w, y);
        }
        expCtx.stroke();
        expCtx.restore();
      }

      // 3. 필기 스트로크 얹기
      expCtx.drawImage(dom.paintCanvas, 0, 0);

      exportCanvas.toBlob(async (blob) => {
        if (!blob) {
          resolve();
          return;
        }

        const subjectStr = state.subject || '테스트';
        const lessonStr = state.lessonName || '단원';
        const dateStr = new Date().toISOString().slice(0, 10);
        const fileName = `백지테스트_${subjectStr}_${lessonStr}_${dateStr}.png`;
        const file = new File([blob], fileName, { type: 'image/png' });

        // 1. iPadOS / 모바일 Web Share API 지원 시 (사진 갤러리 직접 저장 가능)
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          try {
            showToast('공유 창에서 [이미지 저장]을 선택하면 사진(갤러리)에 저장됩니다.', 4500);
            await navigator.share({
              files: [file],
              title: fileName,
              text: '백지테스트 결과물'
            });
            resolve();
            return;
          } catch (e) {
            // 사용자가 공유창을 취소(Abort)한 경우 중복 다운로드 방지
            if (e.name === 'AbortError') {
              resolve();
              return;
            }
          }
        }

        // 2. 일반 브라우저 즉시 다운로드 (확인창 없음)
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);

        if (isAppleTouchDevice()) {
          showToast('다운로드 완료: iPad [파일] 앱 > [다운로드] 폴더를 확인하세요.', 4000);
        } else {
          showToast('이미지 다운로드가 완료되었습니다.', 2500);
        }

        resolve();
      }, 'image/png');
    });
  }

  function resetSession(fullReset = false) {
    state.strokes = [];
    state.undoStack = [];
    state.redoStack = [];
    state.selectedStrokeIds.clear();
    state.lassoBBox = null;
    hideLassoActionBar();
    redrawAll();
    clearOverlay();

    if (fullReset) {
      clearBackgroundImage();
      stopTimer();
      state.timerSeconds = 0;
      state.timerEverStarted = false;
      dom.timerDisplay.textContent = '00:00';
    }
  }

  // ==========================================
  // 12. Supabase 설정 모달
  // ==========================================
  dom.openConfigBtn.addEventListener('click', () => {
    const defaultConfig = window.DEFAULT_SUPABASE_CONFIG || {};
    dom.cfgUrl.value = localStorage.getItem('BLANK_SUPABASE_URL') || defaultConfig.url || '';
    dom.cfgKey.value = localStorage.getItem('BLANK_SUPABASE_KEY') || defaultConfig.key || '';
    dom.configModal.classList.remove('hidden');
  });

  dom.cfgCloseBtn.addEventListener('click', () => {
    dom.configModal.classList.add('hidden');
  });

  dom.cfgSaveBtn.addEventListener('click', () => {
    const url = dom.cfgUrl.value.trim();
    const key = dom.cfgKey.value.trim();
    if (url) localStorage.setItem('BLANK_SUPABASE_URL', url);
    else localStorage.removeItem('BLANK_SUPABASE_URL');

    if (key) localStorage.setItem('BLANK_SUPABASE_KEY', key);
    else localStorage.removeItem('BLANK_SUPABASE_KEY');

    supabase = null;
    dom.configModal.classList.add('hidden');
    loadSubjectsAndLessons();
    syncPendingSchedules();
    alert('Supabase 설정이 저장되었습니다.');
  });

  // ==========================================
  // 13. 초기 실행
  // ==========================================
  async function initApp() {
    updateOnlineBadge();
    await initIndexedDB();
    await loadSubjectsAndLessons();
    syncPendingSchedules();
  }

  initApp();
})();
