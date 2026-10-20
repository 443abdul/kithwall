// v1 ("2010") pages, kept compiling and usable until phase 2 deletes them. Their global stylesheets are
// scoped to this route group so the Kithwall 2 screens start clean. (Next keeps a stylesheet loaded
// after client-side navigation, so styles/v2 out-ranks these rules inside .kw just in case.)
import './kw2010.css';
import './responsive.css';
import '../../styles/mobile-dark.css'; // generated (scripts/gen-dark.mjs); before mobile.css so hand-written rules win
import '../../styles/mobile.css';
import { LegacyDocument } from '@/components/legacy/LegacyDocument';

export default function ClassicLayout({ children }: { children: React.ReactNode }) {
  return <><LegacyDocument />{children}</>;
}
