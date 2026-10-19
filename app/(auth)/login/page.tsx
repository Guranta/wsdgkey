import { LoginForm } from "@/components/login-form";
import { Suspense } from "react";

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-secondary">正在打开登录页…</div>}>
      <LoginForm />
    </Suspense>
  );
}
