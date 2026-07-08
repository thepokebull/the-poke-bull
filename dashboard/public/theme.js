/* THE POKE BULL — shared chrome behavior: sprite background + active nav.
   Purely decorative / progressive-enhancement; never required by page logic. */
(function(){
  // ---- drifting pixel-sprite field ----
  var SPRITES=[1,4,6,7,9,25,26,39,52,54,59,65,68,94,128,129,130,131,133,143,149,150,151];
  function rand(a,b){ return a+Math.random()*(b-a); }
  function buildField(){
    var f=document.getElementById("spritefield");
    if(!f){ f=document.createElement("div"); f.id="spritefield"; document.body.insertBefore(f,document.body.firstChild); }
    var wide=window.innerWidth>720, count=wide?12:6;
    var pool=SPRITES.slice().sort(function(){return Math.random()-.5;}).slice(0,count);
    var frag=document.createDocumentFragment();
    pool.forEach(function(id,i){
      var img=document.createElement("img");
      img.className="pf-sprite"; img.src="/sprites/"+id+".png"; img.alt="";
      var size=Math.round(rand(48,104));
      img.style.width=size+"px";
      img.style.left=rand(1,92).toFixed(2)+"vw";
      img.style.top=rand(4,94).toFixed(2)+"vh";
      img.style.setProperty("--o", rand(.09,.17).toFixed(3));
      var dur=rand(6,13).toFixed(1);
      img.style.animationDuration=dur+"s, 1.4s";
      img.style.animationDelay=(-rand(0,dur)).toFixed(1)+"s, "+(i*.09).toFixed(2)+"s";
      if(Math.random()<.5) img.style.transform="scaleX(-1)";
      frag.appendChild(img);
    });
    f.innerHTML=""; f.appendChild(frag);
  }
  // ---- active nav highlight (matches by pathname) ----
  function markNav(){
    var path=location.pathname.replace(/\/+$/,"")||"/";
    document.querySelectorAll(".hdr-nav .nav-btn").forEach(function(a){
      var href=(a.getAttribute("href")||"").replace(/\/+$/,"")||"/";
      if(href!=="/" && (path===href || path.indexOf(href)===0)) a.classList.add("active");
    });
  }
  function boot(){ try{buildField();}catch(e){} try{markNav();}catch(e){} }
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",boot);
  else boot();
  var rt; window.addEventListener("resize",function(){ clearTimeout(rt); rt=setTimeout(buildField,400); });
})();
