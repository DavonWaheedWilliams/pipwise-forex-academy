// Pipwise student portal. Firebase web identifiers live in firebase-config.js.
// Access control is enforced by Firestore security rules, never by this page alone.
const root = document.getElementById('authRoot');
const appNode = document.getElementById('app');
const cfg = window.PIPWISE_FIREBASE_CONFIG || {};
const configured = Boolean(cfg.apiKey && cfg.projectId && cfg.appId &&
  !Object.values(cfg).some(v => typeof v === 'string' && v.includes('PASTE_')));
const guestKey = 'pipwise_academy_v1';
let auth, db, api, currentUser, currentName = '', selectedName = '';
let authMode = 'login';
let status = 'pending', syncError = null, pendingState = null, syncTimer, inFlight = null;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const valid = value => value && value.version === 1 && Array.isArray(value.trades) &&
  Array.isArray(value.balanceHistory) && value.market && typeof value.completed === 'object';
const getJson = key => { try {return JSON.parse(localStorage.getItem(key) || 'null');} catch {return null;} };
const hasWork = s => valid(s) && (Object.keys(s.completed || {}).length > 0 || s.trades.length > 0 ||
  Boolean(s.exam) || Boolean(s.plan) || (s.balance !== 10000));
const accountKey = uid => 'pipwise_academy_cloud_' + uid;
const dirtyKey = uid => 'pipwise_pending_' + uid;
let progressRef, profileRef;

function message(text, kind='error') {
  const area = root.querySelector('#authMessage');
  if (area) {area.className = kind === 'success' ? 'auth-success' : 'auth-alert'; area.textContent = text;}
}
function frame(body) {
  root.hidden = false;
  root.innerHTML = `<section class="auth-panel" aria-label="Pipwise Academy account">
    <div class="brand"><div class="brand-icon">P<span style="font-size:16px">/</span></div><div><strong>pipwise<span class="accent">.</span></strong><small>FOREX ACADEMY</small></div></div>
    ${body}<div id="authMessage" role="status" aria-live="polite"></div>
    <p class="auth-note">Educational simulation only. No real money or broker connection. Your administrator sees your email, name and learning activity summary, but does not have permission to open private cloud journals. Avoid entering sensitive financial details in journal entries.</p>
  </section>`;
  appNode.hidden = true;
}
function show(mode='login') {
  authMode=mode;
  if (mode==='setup') {
    frame(`<div class="eyebrow">Student portal upgrade</div><h1>Learn Forex at your own pace.</h1>
      <p>Lessons, quizzes and the practice terminal work now in local mode. To activate private student accounts, cloud sync and the administrator dashboard, configure Firebase using the included setup guide.</p>
      <button class="btn" data-auth="guest">Continue learning locally</button>
      <a href="./SETUP_GUIDE.md" style="display:block;margin-top:14px">Firebase setup instructions (SETUP_GUIDE.md)</a>`);
  } else if(mode==='login' || mode==='register') {
    const register=mode==='register';
    frame(`<div class="eyebrow">${register?'Student registration':'Student sign in'}</div><h1>${register?'Create your academy account':'Welcome back to Pipwise'}</h1>
      <p>${register?'Keep your learning progress in a private cloud account.':'Resume lessons and practice on your saved account.'}</p>
      <form id="credentialsForm">
      ${register?'<div class="form-item"><label for="studentName">Name</label><input id="studentName" name="studentName" minlength="2" maxlength="80" autocomplete="name" required></div>':''}
      <div class="form-item"><label for="studentEmail">Email address</label><input id="studentEmail" type="email" name="email" autocomplete="email" required></div>
      <div class="form-item"><label for="studentPassword">Password</label><input id="studentPassword" type="password" name="password" minlength="${register?10:6}" autocomplete="${register?'new-password':'current-password'}" required></div>
      <button class="btn" type="submit" id="authSubmit">${register?'Create account':'Sign in'}</button></form>
      <div class="auth-links"><button type="button" data-auth="${register?'login':'register'}">${register?'Already registered? Sign in':'Create student account'}</button>
      ${register?'':'<button type="button" data-auth="reset">Forgot password?</button>'}</div>
      <div class="auth-links"><button type="button" data-auth="guest">Continue without cloud account</button></div>`);
  } else if(mode==='reset') {
    frame(`<div class="eyebrow">Account recovery</div><h1>Reset your password</h1>
      <p>Enter the email address used for your Pipwise account.</p><form id="resetForm">
      <div class="form-item"><label for="resetEmail">Email address</label><input type="email" id="resetEmail" autocomplete="email" required></div>
      <button class="btn" type="submit">Email reset instructions</button></form>
      <div class="auth-links"><button data-auth="login">Back to sign in</button></div>`);
  } else if(mode==='verify') {
    frame(`<div class="eyebrow">Email verification</div><h1>Check your email</h1>
      <p>We sent a verification link to <strong>${esc(auth?.currentUser?.email || '')}</strong>. Open the link in your email, then return to this screen.</p>
      <button class="btn" data-auth="verify-check">I've verified my email</button>
      <div class="auth-links"><button data-auth="verify-resend">Resend verification email</button><button data-auth="signout">Use another email</button></div>`);
  } else if(mode==='migrate') {
    frame(`<div class="eyebrow">Keep your existing lessons</div><h1>Bring your progress into your account?</h1>
      <p>We found learning history from the previous Pipwise version in this browser. Choose whether to copy it into your new cloud account.</p>
      <button class="btn" data-auth="migrate-yes">Copy my existing progress</button>
      <button class="btn secondary" data-auth="migrate-no">Start a fresh student account</button>`);
  } else if(mode==='conflict') {
    frame(`<div class="eyebrow">Unsaved browser changes</div><h1>Choose your progress</h1>
      <p>This browser has changes which were not confirmed as saved to the cloud. Keep your work from this browser or load the cloud copy.</p>
      <button class="btn" data-auth="conflict-local">Upload this browser's progress</button>
      <button class="btn secondary" data-auth="conflict-cloud">Use my existing cloud progress</button>
      <p class="auth-note">Export a JSON backup first if you need to preserve both copies.</p>`);
  }
}
function bootApp(bridge){
  if (window.PipwiseCloud?.mode) return;
  window.PipwiseCloud=bridge;
  root.hidden=true;
  appNode.hidden=false;
  const script=document.createElement('script');
  script.src='./app.js';
  script.onerror=()=>{root.hidden=false;root.innerHTML='<div class="auth-alert">The academy could not load app.js. Refresh and check your uploaded files.</div>';};
  document.body.appendChild(script);
}
function bootGuest(){
  if (auth?.currentUser) {message('Sign out of your cloud account before opening local guest mode.');return;}
  bootApp({ mode:'guest', isAdmin:false, storageKey:guestKey,
    updateStatus(){const el=document.getElementById('cloudIndicator');if(el)el.textContent='Local only';},
    async logout(){window.location.reload();}
  });
}
function displayStatus() {
  const el=document.getElementById('cloudIndicator'); if(!el)return;
  el.className='status-pill ' + (status==='saved'?'sync-ok':status==='error'?'sync-error':'sync-pending');
  el.textContent=status==='saved'?'Cloud saved':status==='error'?'Sync failed':'Saving to cloud';
  el.title=status==='error'?String(syncError||'Saving failed. Export a backup and check your connection.'):`Signed in as ${currentName}`;
}
function queueSync(state){
  if(!currentUser)return;
  try {
    pendingState=JSON.parse(JSON.stringify(state));
    localStorage.setItem(dirtyKey(currentUser.uid),'1');
    status='pending';syncError=null;displayStatus();
    clearTimeout(syncTimer);syncTimer=setTimeout(()=>{void flushSync();},900);
  } catch (error) {syncError=error;status='error';displayStatus();}
}
async function writeState(state){
  const json=JSON.stringify(state);
  if (new Blob([json]).size>850000)throw new Error('Cloud document is too large. Export a backup and reduce long trading history.');
  await api.setDoc(progressRef,{state,updatedAt:api.serverTimestamp()});
  const count=Object.values(state.completed||{}).filter(n=>Number(n)>=75).length;
  await api.setDoc(profileRef,{lastActiveAt:api.serverTimestamp(),lessonsPassed:count,
    tradesCompleted:state.trades?.length||0,examScore:state.exam?.score??null},{merge:true});
}
async function flushSync() {
  clearTimeout(syncTimer);
  if (inFlight)return inFlight;
  inFlight=(async()=>{
    try {
      while(pendingState){
        const snapshot=pendingState;pendingState=null;
        try{await writeState(snapshot);}
        catch(error){pendingState=pendingState||snapshot;throw error;}
      }
      localStorage.removeItem(dirtyKey(currentUser.uid));status='saved';syncError=null;displayStatus();
    }catch(error){syncError=error;status='error';displayStatus();}
    finally{inFlight=null;}
  })();
  await inFlight;
}
async function signOutClean(){
  if(window.PipwiseCloud?.mode==='cloud' && localStorage.getItem(dirtyKey(currentUser.uid))) {
    await flushSync();
    if(status==='error'){alert('Your latest changes are not saved to the cloud. Export a JSON backup in Your Data before signing out.');return;}
  }
  if(auth)await api.signOut(auth);
  window.location.reload();
}
async function showAdmin(container) {
  if(!container || !window.PipwiseCloud?.isAdmin)return;
  container.innerHTML='<div class="empty">Loading student records...</div>';
  try {
    const result=await api.getDocs(api.collection(db,'users'));
    const profiles=result.docs.map(s=>({uid:s.id,...s.data()})).sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
    const total=profiles.length;
    const active=profiles.filter(p=>p.lastActiveAt && Date.now()-p.lastActiveAt.toMillis()<7*86400e3).length;
    const complete=profiles.reduce((sum,p)=>sum+Number(p.lessonsPassed||0),0);
    container.innerHTML=`<div class="admin-cards"><div class="admin-kpi"><b>${total}</b><span>Registered accounts</span></div>
    <div class="admin-kpi"><b>${active}</b><span>Active in last 7 days</span></div>
    <div class="admin-kpi"><b>${complete}</b><span>Total lessons passed</span></div></div>
    <label for="adminSearch">Search students</label><input id="adminSearch" class="admin-filter" placeholder="Search name or email" autocomplete="off" />
    <div class="table-wrap"><table class="admin-table"><thead><tr><th>Student</th><th>Lessons</th><th>Practice trades</th><th>Final exam</th><th>Last saved</th></tr></thead><tbody id="adminRows"></tbody></table></div>
    <p class="admin-small">Results reflect student-saved practice activity. They are not verified financial performance or qualification for live trading. Students own their account passwords.</p>`;
    const tbody=container.querySelector('#adminRows');
    const stamp=t=>t?.toDate? t.toDate().toLocaleDateString():'Not yet';
    function fill(filter=''){
      const rows=profiles.filter(p=>`${p.name||''} ${p.email||''}`.toLowerCase().includes(filter.toLowerCase()));
      tbody.innerHTML=rows.map(p=>`<tr><td><strong>${esc(p.name||'Student')}</strong><br><span class="subtle">${esc(p.email||'')}</span></td>
      <td>${Math.min(20,Number(p.lessonsPassed||0))}/20</td><td>${Math.max(0,Number(p.tradesCompleted||0))}</td>
      <td>${p.examScore==null?'Not taken':esc(p.examScore)+'%'}</td><td>${esc(stamp(p.lastActiveAt))}</td></tr>`).join('')||'<tr><td colspan="5">No matching accounts.</td></tr>';
    }
    fill(); container.querySelector('#adminSearch').addEventListener('input',e=>fill(e.target.value));
  } catch(error){container.innerHTML=`<div class="auth-alert">Unable to load the student dashboard. Verify your UID in firebase-config.js and firestore.rules. ${esc(error.message)}</div>`;}
}
async function finalize(savedState){
  localStorage.setItem(accountKey(currentUser.uid),JSON.stringify(savedState));
  status='saved';
  bootApp({ mode:'cloud',isAdmin:currentUser.uid===window.PIPWISE_ADMIN_UID,
    storageKey:accountKey(currentUser.uid),name:currentName,
    queueSync,flush:flushSync,updateStatus:displayStatus,renderAdmin:showAdmin,logout:signOutClean});
  displayStatus();
}
let remoteState=null;
async function activateAccount(user){
  if(window.PipwiseCloud?.mode==='cloud')return;
  currentUser=user;
  progressRef=api.doc(db,'progress',user.uid);
  profileRef=api.doc(db,'users',user.uid);
  try {
    const profile=await api.getDoc(profileRef);
    currentName=profile.exists()?profile.data().name : (user.displayName||selectedName||user.email.split('@')[0]).slice(0,80);
    if(!profile.exists())await api.setDoc(profileRef,{name:currentName,email:user.email,
      createdAt:api.serverTimestamp(),lastActiveAt:api.serverTimestamp(),lessonsPassed:0,tradesCompleted:0,examScore:null});
    const snapshot=await api.getDoc(progressRef);
    remoteState=snapshot.exists()?snapshot.data().state:null;
    const onDisk=getJson(accountKey(user.uid));
    if(localStorage.getItem(dirtyKey(user.uid)) && valid(onDisk)) {show('conflict');return;}
    if(valid(remoteState)) {await finalize(remoteState);return;}
    if(hasWork(getJson(guestKey))) {show('migrate');return;}
    await finalize({version:1,completed:{},plan:'',balance:10000,balanceHistory:[10000],trades:[],open:null,
      market:{pair:'EUR/USD',scenario:'Uptrend',mode:'synthetic',seed:101,index:85},imported:null,sessionStart:10000,sessionPnL:0,exam:null});
  }catch(error){show('login');message(`Cloud account could not open: ${error.message}\nCheck Firestore, its rules, and your internet connection.`);}
}
async function decide(choice){
  const key=accountKey(currentUser.uid);
  try {
    let state;
    if(choice==='migrate-yes')state=getJson(guestKey);
    else if(choice==='conflict-local')state=getJson(key);
    else if(choice==='conflict-cloud')state=remoteState;
    else state={version:1,completed:{},plan:'',balance:10000,balanceHistory:[10000],trades:[],open:null,
      market:{pair:'EUR/USD',scenario:'Uptrend',mode:'synthetic',seed:101,index:85},imported:null,sessionStart:10000,sessionPnL:0,exam:null};
    if(!valid(state))throw new Error('Local progress file is invalid');
    if(choice==='migrate-yes'||choice==='migrate-no'||choice==='conflict-local')await writeState(state);
    localStorage.removeItem(dirtyKey(currentUser.uid));
    await finalize(state);
  }catch(error){message(`Progress transfer failed: ${error.message}`);}
}
root.addEventListener('submit',async e=>{
  e.preventDefault();
  const form=e.target;
  const submit=form.querySelector('button[type="submit"]');
  if(submit)submit.disabled=true;
  try {
    if(form.id==='resetForm'){
      await api.sendPasswordResetEmail(auth,document.getElementById('resetEmail').value.trim());
      message('If this email has an account, reset instructions have been sent.','success');
    } else if(form.id==='credentialsForm') {
      const email=document.getElementById('studentEmail').value.trim();
      const password=document.getElementById('studentPassword').value;
      if(authMode==='register'){
        selectedName=document.getElementById('studentName').value.trim();
        if(selectedName.length<2)throw new Error('Enter a name with at least two characters.');
        if(password.length<10)throw new Error('Choose a password with at least 10 characters.');
        const result=await api.createUserWithEmailAndPassword(auth,email,password);
        await api.updateProfile(result.user,{displayName:selectedName});
        await api.sendEmailVerification(result.user);
        show('verify');message('Verification email sent.','success');
      }else await api.signInWithEmailAndPassword(auth,email,password);
    }
  }catch(error){message(error.message||'Request failed. Try again.');}
  finally{if(submit)submit.disabled=false;}
});
root.addEventListener('click',async e=>{
  const btn=e.target.closest('[data-auth]');if(!btn)return;
  const action=btn.dataset.auth;btn.disabled=true;
  try {
    if(action==='guest')bootGuest();
    else if(['login','register','reset'].includes(action))show(action);
    else if(action==='signout')await signOutClean();
    else if(action==='migrate-yes'||action==='migrate-no'||action==='conflict-local'||action==='conflict-cloud')await decide(action);
    else if(action==='verify-resend'){
      await api.sendEmailVerification(auth.currentUser);message('Verification email sent.','success');
    }else if(action==='verify-check'){
      await api.reload(auth.currentUser);
      await auth.currentUser.getIdToken(true);
      if(!auth.currentUser.emailVerified)message('Your email is not verified yet. Open the verification link and try again.');
      else await activateAccount(auth.currentUser);
    }
  }catch(error){message(error.message||'Request failed.');}
  finally{btn.disabled=false;}
});
window.addEventListener('online',()=>{if(window.PipwiseCloud?.mode==='cloud' && pendingState)void flushSync();});
async function begin(){
  if(!configured){show('setup');return;}
  try {
    const ver='12.19.0';
    const [base,users,store]=await Promise.all([
      import(`https://www.gstatic.com/firebasejs/${ver}/firebase-app.js`),
      import(`https://www.gstatic.com/firebasejs/${ver}/firebase-auth.js`),
      import(`https://www.gstatic.com/firebasejs/${ver}/firebase-firestore.js`)
    ]);
    api={...users,...store};
    const firebase=base.initializeApp(cfg);
    auth=users.getAuth(firebase);db=store.getFirestore(firebase);
    await users.setPersistence(auth,users.browserLocalPersistence);
    users.onAuthStateChanged(auth,user=>{
      if(window.PipwiseCloud?.mode)return;
      if(!user){show('login');return;}
      if(!user.emailVerified){show('verify');return;}
      void activateAccount(user);
    },error=>{show('login');message(error.message);});
  }catch(error){show('setup');message(`Firebase could not load: ${error.message}. Your local academy remains available.`);}
}
void begin();
