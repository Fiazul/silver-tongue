if(new URLSearchParams(location.search).get('embedded')==='1' && parent!==window) {
 document.documentElement.classList.add('embedded-journey');
 document.addEventListener('click',event=>{
  const anchor=event.target.closest('a');
  if(!anchor || anchor.hasAttribute('download')) return;
  const url=new URL(anchor.href,location.href);
  if(url.origin!==location.origin) return;
  if(url.pathname==='/') {
   event.preventDefault();parent.postMessage({type:'journey:close-panel'},location.origin);
  } else if(['/room','/story','/scenes'].includes(url.pathname)) {
   url.searchParams.set('embedded','1');anchor.href=url.href;
  }
 });
 document.addEventListener('keydown',event=>{
  if(event.key==='Escape' && !event.defaultPrevented && !document.querySelector('dialog[open]')) {
   parent.postMessage({type:'journey:close-panel'},location.origin);
  }
 });
}
