'use strict';
// Names identify the cast; every character uses the same neutral silhouette.
window.facelessIcon = function(className = '') {
 const icon = document.createElement('span');
 icon.className = `faceless-icon ${className}`.trim();
 icon.setAttribute('aria-hidden', 'true');
 return icon;
};
