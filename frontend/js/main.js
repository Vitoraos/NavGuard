(function() {
  'use strict';

  const mobileMenuBtn = document.querySelector('.mobile-menu-btn');
  const mobileNav = document.querySelector('.mobile-nav');
  const mobileNavClose = document.querySelector('.mobile-nav-close');
  const mobileNavLinks = document.querySelectorAll('.mobile-nav-link');

  function openMobileNav() { if (mobileNav) mobileNav.classList.add('open'); document.body.style.overflow = 'hidden'; }
  function closeMobileNav() { if (mobileNav) mobileNav.classList.remove('open'); document.body.style.overflow = ''; }

  if (mobileMenuBtn) mobileMenuBtn.addEventListener('click', openMobileNav);
  if (mobileNavClose) mobileNavClose.addEventListener('click', closeMobileNav);
  mobileNavLinks.forEach(link => link.addEventListener('click', closeMobileNav));

  document.querySelectorAll('.code-copy').forEach(btn => {
    btn.addEventListener('click', async function() {
      const codeBlock = this.closest('.code-block').querySelector('pre');
      if (!codeBlock) return;
      try {
        await navigator.clipboard.writeText(codeBlock.textContent);
        const originalText = this.textContent;
        this.textContent = 'Copied!';
        this.classList.add('copied');
        setTimeout(() => { this.textContent = originalText; this.classList.remove('copied'); }, 2000);
      } catch (err) { console.error('Copy failed:', err); }
    });
  });

  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
      const targetId = this.getAttribute('href');
      if (targetId === '#') return;
      const target = document.querySelector(targetId);
      if (target) {
        e.preventDefault();
        const navHeight = document.querySelector('.nav')?.offsetHeight || 64;
        const targetPosition = target.getBoundingClientRect().top + window.pageYOffset - navHeight - 20;
        window.scrollTo({ top: targetPosition, behavior: 'smooth' });
      }
    });
  });

  const fadeObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'translateY(0)';
        fadeObserver.unobserve(entry.target);
      }
    });
  }, { root: null, rootMargin: '0px 0px -50px 0px', threshold: 0.1 });

  document.querySelectorAll('.fade-in').forEach(el => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(20px)';
    el.style.transition = 'opacity 0.6s cubic-bezier(0.4, 0, 0.2, 1), transform 0.6s cubic-bezier(0.4, 0, 0.2, 1)';
    fadeObserver.observe(el);
  });

  const canvas = document.getElementById('heroCanvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    let animationId;
    let time = 0;

    function resizeCanvas() {
      const parent = canvas.parentElement;
      canvas.width = parent.clientWidth * window.devicePixelRatio;
      canvas.height = parent.clientHeight * window.devicePixelRatio;
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
      canvas.style.width = parent.clientWidth + 'px';
      canvas.style.height = parent.clientHeight + 'px';
    }
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    const GRID_COLS = 12;
    const GRID_ROWS = 8;
    const CELL_SIZE = 28;
    const GRID_SPACING = 36;
    const LAYERS = 3;

    function drawGrid() {
      const width = canvas.width / window.devicePixelRatio;
      const height = canvas.height / window.devicePixelRatio;
      const centerX = width / 2;
      const centerY = height / 2;
      const gridWidth = (GRID_COLS - 1) * GRID_SPACING;
      const gridHeight = (GRID_ROWS - 1) * GRID_SPACING;
      const offsetX = centerX - gridWidth / 2;
      const offsetY = centerY - gridHeight / 2;
      ctx.clearRect(0, 0, width, height);

      for (let layer = 0; layer < LAYERS; layer++) {
        const layerOffset = layer * 8;
        const size = CELL_SIZE - (layer * 4);
        for (let row = 0; row < GRID_ROWS; row++) {
          for (let col = 0; col < GRID_COLS; col++) {
            const x = offsetX + col * GRID_SPACING + layerOffset;
            const y = offsetY + row * GRID_SPACING - layerOffset;
            const wave = Math.sin(time * 0.02 + col * 0.3 + row * 0.2 + layer * 0.5) * 0.5 + 0.5;
            const isRestricted = Math.sin(time * 0.01 + col * 0.5 + row * 0.4) > 0.6;
            const isPath = Math.abs(col - 6 + Math.sin(row * 0.5 + time * 0.01) * 2) < 1.5;
            let color;
            if (isPath && layer === 0) { color = `rgba(6, 182, 212, ${0.6 + wave * 0.4})`; }
            else if (isRestricted) { color = `rgba(239, 68, 68, ${0.3 + wave * 0.2})`; }
            else { color = `rgba(148, 163, 184, ${0.1 + wave * 0.1})`; }
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.roundRect(x - size/2, y - size/2, size, size, 3);
            ctx.fill();
            if (isPath && layer === 0) {
              ctx.shadowColor = 'rgba(6, 182, 212, 0.5)';
              ctx.shadowBlur = 12;
              ctx.fillStyle = `rgba(6, 182, 212, ${0.3 + wave * 0.2})`;
              ctx.beginPath();
              ctx.arc(x, y, 3, 0, Math.PI * 2);
              ctx.fill();
              ctx.shadowBlur = 0;
            }
          }
        }
      }

      ctx.strokeStyle = 'rgba(6, 182, 212, 0.4)';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      const pathPoints = [];
      for (let row = 0; row < GRID_ROWS; row++) {
        const col = 6 + Math.sin(row * 0.5 + time * 0.01) * 2;
        const x = offsetX + col * GRID_SPACING;
        const y = offsetY + row * GRID_SPACING;
        pathPoints.push({x, y});
      }
      if (pathPoints.length > 0) {
        ctx.moveTo(pathPoints[0].x, pathPoints[0].y);
        for (let i = 1; i < pathPoints.length; i++) { ctx.lineTo(pathPoints[i].x, pathPoints[i].y); }
      }
      ctx.stroke();
      ctx.setLineDash([]);

      const droneRow = Math.floor((time * 0.05) % GRID_ROWS);
      const droneCol = 6 + Math.sin(droneRow * 0.5 + time * 0.01) * 2;
      const droneX = offsetX + droneCol * GRID_SPACING;
      const droneY = offsetY + droneRow * GRID_SPACING;
      ctx.shadowColor = 'rgba(6, 182, 212, 0.8)';
      ctx.shadowBlur = 20;
      ctx.fillStyle = '#06b6d4';
      ctx.beginPath();
      ctx.arc(droneX, droneY, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(droneX, droneY, 2.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.fillStyle = 'rgba(148, 163, 184, 0.4)';
      ctx.textAlign = 'left';
      ctx.fillText('850hPa', offsetX + gridWidth + 15, offsetY - 8 + 0);
      ctx.fillText('925hPa', offsetX + gridWidth + 15, offsetY - 8 + 8);
      ctx.fillText('SURFACE', offsetX + gridWidth + 15, offsetY - 8 + 16);
    }

    function animate() { time++; drawGrid(); animationId = requestAnimationFrame(animate); }
    const canvasObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) { if (!animationId) animate(); }
        else { if (animationId) { cancelAnimationFrame(animationId); animationId = null; } }
      });
    });
    canvasObserver.observe(canvas);
    animate();
  }

  const docsNavItems = document.querySelectorAll('.docs-nav-item, .docs-nav-sub-item');
  const docsSections = document.querySelectorAll('.docs-section');
  if (docsNavItems.length > 0 && docsSections.length > 0) {
    docsNavItems.forEach(item => {
      item.addEventListener('click', function() {
        const targetId = this.getAttribute('data-target');
        if (!targetId) return;
        docsNavItems.forEach(nav => nav.classList.remove('active'));
        this.classList.add('active');
        const target = document.getElementById(targetId);
        if (target) {
          const navHeight = document.querySelector('.nav')?.offsetHeight || 64;
          const targetPosition = target.getBoundingClientRect().top + window.pageYOffset - navHeight - 20;
          window.scrollTo({ top: targetPosition, behavior: 'smooth' });
        }
      });
    });
    const scrollSpyObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const id = entry.target.id;
          docsNavItems.forEach(nav => {
            nav.classList.remove('active');
            if (nav.getAttribute('data-target') === id) { nav.classList.add('active'); }
          });
        }
      });
    }, { rootMargin: '-20% 0px -80% 0px' });
    docsSections.forEach(section => scrollSpyObserver.observe(section));
  }

  const nav = document.querySelector('.nav');
  if (nav) {
    window.addEventListener('scroll', () => {
      const currentScroll = window.pageYOffset;
      if (currentScroll > 50) {
        nav.style.background = 'rgba(11, 15, 25, 0.95)';
        nav.style.backdropFilter = 'blur(16px)';
      } else {
        nav.style.background = 'rgba(11, 15, 25, 0.8)';
        nav.style.backdropFilter = 'blur(12px)';
      }
    }, { passive: true });
  }
})();