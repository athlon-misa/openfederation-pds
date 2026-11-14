import { redirect } from 'next/navigation';

/** Settings became the account area (#404); old links and bookmarks land there. */
export default function SettingsPage() {
  redirect('/account');
}
