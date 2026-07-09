import { redirect } from 'next/navigation';
 
export default function HomePage() {
  // Redirect to English locale by default
  redirect('/en');
}
