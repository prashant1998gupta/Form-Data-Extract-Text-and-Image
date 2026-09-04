import { redirect } from "next/navigation";

/** Scanning starts by choosing a form, which is the home screen. */
export default function ScanIndex() {
  redirect("/");
}
