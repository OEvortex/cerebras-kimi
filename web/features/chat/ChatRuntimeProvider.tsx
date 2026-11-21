"use client";

import { createContext, useContext, type ReactNode } from "react";

import NotebookNotifications from "@/features/notebook-ui/NotebookNotifications";

import { ChatStateAdapterProvider } from "./ChatStateAdapter";

const ChatRuntimeContext = createContext(false);

export function ChatRuntimeProvider({ children }: { children: ReactNode }) {
  const parent = useContext(ChatRuntimeContext);
  if (parent && process.env.NODE_ENV !== "production") {
    throw new Error(
      "ChatRuntimeProvider cannot be nested; scope one runtime per route subtree",
    );
  }

  return (
    <ChatRuntimeContext.Provider value>
      <NotebookNotifications />
      <ChatStateAdapterProvider>{children}</ChatStateAdapterProvider>
    </ChatRuntimeContext.Provider>
  );
}
