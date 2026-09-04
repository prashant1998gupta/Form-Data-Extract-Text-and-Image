import Image from "next/image";
import Link from "next/link";

import { ArrowRight } from "@/components/icons";
import { fieldsOf, FORMS } from "@/lib/forms/definitions";

/** The forms this app can scan, as cards. Picking one opens its scan screen. */
export default function FormChooser() {
  return (
    <div className="chooser-grid">
      {FORMS.map((form) => (
        <Link key={form.id} className="form-card" href={`/scan/${form.id}`}>
          <div className="form-thumb">
            <Image src={form.thumbnail} alt={`A blank ${form.name}`} width={350} height={495} sizes="(max-width: 640px) 38vw, 240px" />
          </div>
          <div className="form-card-body">
            <h2>{form.name}</h2>
            <p>{form.description}</p>
            <ul className="form-facts">
              <li>{fieldsOf(form).length} fields</li>
              <li>{form.sections.length} sections</li>
              <li>{form.photo.label}</li>
            </ul>
            <span className="form-card-go">
              Scan this form <ArrowRight size={18} />
            </span>
          </div>
        </Link>
      ))}
    </div>
  );
}
