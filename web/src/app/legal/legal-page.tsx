import { Header } from "@/components/site/header";
import { Footer } from "@/components/site/footer";
import { BRAND } from "@/lib/config";

export type Section = { heading: string; body: string[] };

export function LegalPage({
  title,
  updated,
  intro,
  sections,
}: {
  title: string;
  updated: string;
  intro: string;
  sections: Section[];
}) {
  return (
    <>
      <Header />
      <main>
        <article className="mx-auto max-w-3xl px-4 py-14 sm:px-6 lg:py-20">
          <header className="mb-8 flex flex-col gap-2 border-b border-rule pb-6">
            <h1 className="display text-[clamp(2.25rem,5.5vw,3.5rem)] text-ink">
              {title}
            </h1>
            <p className="meta">Last updated {updated}</p>
            <p className="text-sm leading-relaxed text-muted">{intro}</p>
          </header>

          <div className="flex flex-col gap-8">
            {sections.map((section) => (
              <section key={section.heading} className="flex flex-col gap-2">
                <h2 className="text-lg font-semibold tracking-tight text-ink">
                  {section.heading}
                </h2>
                {section.body.map((paragraph) => (
                  <p
                    key={paragraph.slice(0, 24)}
                    className="text-[0.9375rem] leading-relaxed text-muted"
                  >
                    {paragraph}
                  </p>
                ))}
              </section>
            ))}
          </div>

          <p className="mt-10 border-t border-rule pt-6 text-[0.8125rem] leading-relaxed text-faint">
            Questions about any of this go to{" "}
            <a
              href={`mailto:${BRAND.contactEmail}`}
              className="underline underline-offset-2 hover:text-ink"
            >
              {BRAND.contactEmail}
            </a>
            .
          </p>
        </article>
      </main>
      <Footer />
    </>
  );
}
