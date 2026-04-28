import { useState, useEffect, useRef } from 'react';

function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || (navigator as any).standalone === true;
}

function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

function getDismissCount(): number {
  return parseInt(localStorage.getItem('cmux-relay-install-dismiss-count') || '0', 10);
}

function incrementDismissCount() {
  const count = getDismissCount() + 1;
  localStorage.setItem('cmux-relay-install-dismiss-count', String(count));
}

export function InstallBanner() {
  const [visible, setVisible] = useState(false);
  const [iosMode, setIosMode] = useState(false);
  const [hasNativePrompt, setHasNativePrompt] = useState(false);
  const deferredPromptRef = useRef<any>(null);
  const prompted = useRef(false);

  useEffect(() => {
    if (isStandalone() || prompted.current) return;

    const isIos = isIOS();
    const dismissCount = getDismissCount();

    if (dismissCount >= 3) return;

    const timer = setTimeout(() => {
      if (isStandalone()) return;

      if (isIos) {
        setIosMode(true);
        setVisible(true);
        prompted.current = true;
      } else {
        // Listen for Chrome's native install prompt
        const handler = (e: Event) => {
          e.preventDefault();
          deferredPromptRef.current = e;
          setHasNativePrompt(true);
          setVisible(true);
          prompted.current = true;
        };
        window.addEventListener('beforeinstallprompt', handler);

        // Fallback: show generic banner after 1s if no native prompt
        setTimeout(() => {
          if (!prompted.current) {
            setVisible(true);
            prompted.current = true;
          }
        }, 1000);

        return () => window.removeEventListener('beforeinstallprompt', handler);
      }
    }, 2000);

    return () => clearTimeout(timer);
  }, []);

  const handleInstall = async () => {
    const prompt = deferredPromptRef.current;
    if (prompt) {
      prompt.prompt();
      await prompt.userChoice;
      deferredPromptRef.current = null;
    }
    setVisible(false);
  };

  const handleDismiss = () => {
    setVisible(false);
    incrementDismissCount();
  };

  if (!visible) return null;

  return (
    <div className="install-banner-overlay" onClick={handleDismiss}>
      <div className="install-banner" onClick={(e) => e.stopPropagation()}>
        <button className="install-banner-close" onClick={handleDismiss}>&times;</button>
        <div className="install-banner-icon">📱</div>
        <div className="install-banner-content">
          <div className="install-banner-title">앱으로 설치하기</div>
          <div className="install-banner-desc">
            {iosMode ? (
              <>하단 <strong>공유 버튼</strong> → <strong>&quot;홈 화면에 추가&quot;</strong></>
            ) : hasNativePrompt ? (
              '홈 화면에 추가하면 알림을 바로 받을 수 있습니다'
            ) : (
              '브라우저 메뉴에서 &quot;홈 화면에 추가&quot;를 선택하세요'
            )}
          </div>
        </div>
        {hasNativePrompt && (
          <button className="install-banner-btn" onClick={handleInstall}>설치</button>
        )}
      </div>
    </div>
  );
}
