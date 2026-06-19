
    function mintHubDropdownToggle(e) {
      e.stopPropagation();
      const dd = document.getElementById('mintHubDropdown');
      const ch = document.getElementById('mintHubChevron');
      const open = dd.style.display !== 'block';
      dd.style.display = open ? 'block' : 'none';
      if (ch) ch.style.transform = open ? 'rotate(180deg)' : '';
      if (open) {
        setTimeout(() => {
          const close = (ev) => {
            if (!ev.target.closest('.sidebar-header')) {
              dd.style.display = 'none';
              if (ch) ch.style.transform = '';
              document.removeEventListener('click', close);
            }
          };
          document.addEventListener('click', close);
        }, 0);
      }
    }
    function mintAppLaunch() {
      const dd = document.getElementById('mintHubDropdown');
      const ch = document.getElementById('mintHubChevron');
      if (dd) dd.style.display = 'none';
      if (ch) ch.style.transform = '';
      const ov = document.getElementById('mintAppOverlay');
      const fr = document.getElementById('mintAppFrame');
      if (ov && fr) { fr.src = 'https://mint-henna.vercel.app/'; ov.style.display = 'block'; }
    }
    function mintAppClose() {
      const ov = document.getElementById('mintAppOverlay');
      const fr = document.getElementById('mintAppFrame');
      if (ov) ov.style.display = 'none';
      if (fr) fr.src = '';
    }
    