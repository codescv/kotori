package dev.kotori.app;

import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.hardware.SensorManager;
import android.os.Build;
import android.os.Bundle;
import android.view.OrientationEventListener;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import java.util.Locale;

public class MainActivity extends BridgeActivity {
    private float safeTopDp = 0f;
    private float safeRightDp = 0f;
    private float safeBottomDp = 0f;
    private float safeLeftDp = 0f;
    private boolean immersive = false;
    private OrientationEventListener portraitUnlockListener;
    private Runnable portraitUnlockFallbackRunnable;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KotoriTorrentPlugin.class);
        super.onCreate(savedInstanceState);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                dispatchBackToWebView();
            }
        });

        Window window = getWindow();
        if (window != null) {
            WindowCompat.setDecorFitsSystemWindows(window, false);
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.TRANSPARENT);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                window.setStatusBarContrastEnforced(false);
                window.setNavigationBarContrastEnforced(false);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                WindowManager.LayoutParams lp = window.getAttributes();
                lp.layoutInDisplayCutoutMode =
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                        ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                        : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                window.setAttributes(lp);
            }

            View decorView = window.getDecorView();
            WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(window, decorView);
            if (controller != null) {
                controller.setAppearanceLightStatusBars(false);
                controller.setAppearanceLightNavigationBars(false);
            }

            View content = findViewById(android.R.id.content);
            if (content != null) {
                content.setPadding(0, 0, 0, 0);
            }

            ViewCompat.setOnApplyWindowInsetsListener(decorView, (v, windowInsets) -> {
                Insets bars = windowInsets.getInsets(
                    this.immersive
                        ? WindowInsetsCompat.Type.displayCutout()
                        : (WindowInsetsCompat.Type.systemBars()
                            | WindowInsetsCompat.Type.displayCutout())
                );
                Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
                boolean kbVisible = windowInsets.isVisible(WindowInsetsCompat.Type.ime());
                float density = getResources().getDisplayMetrics().density;
                if (density <= 0f) density = 1f;
                safeTopDp = bars.top / density;
                safeRightDp = bars.right / density;
                safeBottomDp = (kbVisible ? 0 : bars.bottom) / density;
                safeLeftDp = bars.left / density;

                // Keep DecorView & WebView 100% edge-to-edge full screen; only pad bottom when IME is visible.
                int imePadBottom = kbVisible && ime.bottom > bars.bottom ? ime.bottom : 0;
                v.setPadding(0, 0, 0, imePadBottom);
                if (content != null) {
                    content.setPadding(0, 0, 0, 0);
                }
                syncSafeAreaCssVars();

                return new WindowInsetsCompat.Builder(windowInsets)
                    .setInsets(
                        WindowInsetsCompat.Type.systemBars()
                            | WindowInsetsCompat.Type.displayCutout(),
                        Insets.of(0, 0, 0, 0)
                    )
                    .build();
            });
            ViewCompat.requestApplyInsets(decorView);
        }

        if (getBridge() != null) {
            getBridge().addWebViewListener(new WebViewListener() {
                @Override
                public void onPageCommitVisible(WebView view, String url) {
                    syncSafeAreaCssVars();
                }

                @Override
                public void onPageLoaded(WebView view) {
                    syncSafeAreaCssVars();
                }
            });
            if (getBridge().getWebView() != null) {
                WebView webView = getBridge().getWebView();
                webView.postDelayed(this::syncSafeAreaCssVars, 150);
                webView.postDelayed(this::syncSafeAreaCssVars, 600);
            }
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        if (getWindow() != null) {
            ViewCompat.requestApplyInsets(getWindow().getDecorView());
        }
        syncSafeAreaCssVars();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && immersive) {
            setImmersive(true, "keep");
        }
    }

    @Override
    public void onDestroy() {
        cancelPortraitUnlock();
        super.onDestroy();
    }

    public void setImmersive(boolean on, String orientation) {
        this.immersive = on;
        cancelPortraitUnlock();

        Window window = getWindow();
        View decorView = window != null ? window.getDecorView() : null;
        if (window != null && decorView != null) {
            WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(window, decorView);
            if (controller != null) {
                controller.setSystemBarsBehavior(
                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                );
                if (on) {
                    controller.hide(WindowInsetsCompat.Type.systemBars());
                } else {
                    controller.show(WindowInsetsCompat.Type.systemBars());
                }
            }
            if (on) {
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } else {
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
        }

        String mode = orientation == null ? "keep" : orientation;
        switch (mode) {
            case "landscape":
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                break;
            case "portrait-then-unlock":
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_USER_PORTRAIT);
                portraitUnlockListener = new OrientationEventListener(
                    this,
                    SensorManager.SENSOR_DELAY_NORMAL
                ) {
                    @Override
                    public void onOrientationChanged(int deg) {
                        if (deg != OrientationEventListener.ORIENTATION_UNKNOWN
                            && ((deg >= 330 || deg <= 30) || (deg >= 150 && deg <= 210))
                            && !immersive) {
                            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                            disable();
                            if (portraitUnlockListener == this) {
                                portraitUnlockListener = null;
                            }
                        }
                    }
                };
                if (portraitUnlockListener.canDetectOrientation()) {
                    portraitUnlockListener.enable();
                } else {
                    portraitUnlockListener.disable();
                    portraitUnlockListener = null;
                    if (decorView != null) {
                        portraitUnlockFallbackRunnable = () -> {
                            portraitUnlockFallbackRunnable = null;
                            if (!immersive) {
                                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                            }
                        };
                        decorView.postDelayed(portraitUnlockFallbackRunnable, 1500);
                    }
                }
                break;
            case "keep":
            default:
                break;
        }

        if (decorView != null) {
            ViewCompat.requestApplyInsets(decorView);
        }
    }

    private void cancelPortraitUnlock() {
        if (portraitUnlockListener != null) {
            portraitUnlockListener.disable();
            portraitUnlockListener = null;
        }
        if (portraitUnlockFallbackRunnable != null) {
            Window window = getWindow();
            if (window != null && window.getDecorView() != null) {
                window.getDecorView().removeCallbacks(portraitUnlockFallbackRunnable);
            }
            portraitUnlockFallbackRunnable = null;
        }
    }

    private void syncSafeAreaCssVars() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        WebView webView = getBridge().getWebView();
        String js = String.format(
            Locale.US,
            "(function(){var r=document.documentElement.style;"
                + "r.setProperty('--k-safe-top','%.2fpx');"
                + "r.setProperty('--k-safe-right','%.2fpx');"
                + "r.setProperty('--k-safe-bottom','%.2fpx');"
                + "r.setProperty('--k-safe-left','%.2fpx');"
                + "r.setProperty('--safe-area-inset-top','%.2fpx');"
                + "r.setProperty('--safe-area-inset-right','%.2fpx');"
                + "r.setProperty('--safe-area-inset-bottom','%.2fpx');"
                + "r.setProperty('--safe-area-inset-left','%.2fpx');"
                + "})();",
            safeTopDp, safeRightDp, safeBottomDp, safeLeftDp,
            safeTopDp, safeRightDp, safeBottomDp, safeLeftDp
        );
        webView.post(() -> webView.evaluateJavascript(js, null));
    }

    private void dispatchBackToWebView() {
        if (getBridge() != null && getBridge().getWebView() != null) {
            WebView webView = getBridge().getWebView();
            webView.post(() -> webView.evaluateJavascript(
                "(function(){try{return window.__kotoriHandleBack?Boolean(window.__kotoriHandleBack()):false;}catch(e){return false;}})()",
                result -> {
                    if (!"true".equals(result)) {
                        moveTaskToBack(true);
                    }
                }
            ));
        } else {
            moveTaskToBack(true);
        }
    }
}
