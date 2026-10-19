import { redirect } from "next/navigation";

export default function ConnectionsRedirect() {
  redirect("/channels");
}
