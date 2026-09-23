"use client";

import { useEffect, useCallback } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  width?: string;
  /**
   * 内容区内边距，默认 "24px"（既有弹窗行为不变）。
   * ⚠️ 底部有 sticky 吸底操作区的弹窗必须传 `"24px 24px 0"`：
   * 滚动容器的 padding 区也能显示滚动内容，而 sticky 元素被限制在父级 content box 内，
   * 永远盖不住 body 的 padding-bottom —— 那 24px 里会漏出下层内容。
   * 把底部内边距交给吸底区自己的 padding 承担，即可彻底盖住。
   */
  bodyPadding?: string;
}

export default function Modal({
  open,
  onClose,
  title,
  children,
  width = "460px",
  bodyPadding = "24px",
}: ModalProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );

  useEffect(() => {
    if (open) {
      document.addEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [open, handleKeyDown]);

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* 遮罩 */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0,0,0,0.3)",
        }}
        onClick={onClose}
      />

      {/* 弹窗 */}
      <div
        style={{
          position: "relative",
          width,
          maxWidth: "90vw",
          // ⚠️ 必须限高 + 内部滚动：内容比视口高时（如权限弹窗 12 个页面 + 额度区），
          //    居中布局会把标题栏和底部按钮**同时挤出屏幕**，用户就「看不见完整弹窗」。
          //    限高后由内容区自己滚动，头部与底部操作区始终可见。
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          background: "#fff",
          borderRadius: 16,
          boxShadow: "0 8px 32px rgba(0,0,0,0.12)",
          zIndex: 1001,
          animation: "fadeIn 0.15s ease-out",
        }}
      >
        {/* 头部 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "20px 24px",
            borderBottom: "1px solid #E2E8F0",
            flexShrink: 0,
          }}
        >
          <h2
            style={{
              fontSize: 16,
              fontWeight: 700,
              color: "#0F172A",
              margin: 0,
            }}
          >
            {title}
          </h2>
          <button
            onClick={onClose}
            style={{
              width: 32,
              height: 32,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "none",
              background: "transparent",
              borderRadius: 6,
              cursor: "pointer",
              color: "#94A3B8",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = "#F1F5F9";
              (e.currentTarget as HTMLElement).style.color = "#1E293B";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = "";
              (e.currentTarget as HTMLElement).style.color = "#94A3B8";
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* 内容（超高时在这里滚动，标题与底部按钮保持可见） */}
        <div
          data-testid="modal-body"
          style={{ padding: bodyPadding, overflowY: "auto", flex: "1 1 auto", minHeight: 0 }}
        >
          {children}
        </div>
      </div>

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: scale(0.95); }
          to { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  );
}
