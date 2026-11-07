import { describe, expect, it } from "vitest";
import { defaultFormFields, formDefinitionSchema } from "@kytelink/schemas";
import { escapeHtml, renderFormHtml } from "./render";

describe("escapeHtml", () => {
  it("escapes markup breakouts", () => {
    expect(escapeHtml(`"><script>alert(1)</script>`)).toBe(
      "&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });
});

describe("renderFormHtml", () => {
  const def = formDefinitionSchema.parse({
    fields: [
      ...defaultFormFields(),
      { id: "topic", type: "choice", label: "Topic", options: ["Hello", "Business"] },
    ],
  });

  it("renders one input per field plus a honeypot and a submit button", () => {
    const html = renderFormHtml(def, {
      endpointPath: "/forms/submit/abc123",
      title: "Contact me",
      buttonText: "Send message",
    });
    expect(html).toContain('<form action="/forms/submit/abc123" method="post">');
    expect(html).toContain('type="text" id="freetree-name" name="name"');
    expect(html).toContain('type="email" id="freetree-email" name="email"');
    expect(html).toContain('<textarea id="freetree-message" name="message"');
    expect(html).toContain('<select id="freetree-topic" name="topic"');
    expect(html).toContain('<option value="Business">Business</option>');
    expect(html).toContain('name="website" tabindex="-1"');
    expect(html).toContain("<button type=\"submit\">Send message</button>");
  });

  it("escapes seller-controlled labels, placeholders, and options", () => {
    const evil = formDefinitionSchema.parse({
      fields: [
        {
          id: "x",
          type: "text",
          label: `"><img src=x onerror=alert(1)>`,
          placeholder: `"><script>alert(2)</script>`,
        },
      ],
    });
    const html = renderFormHtml(evil, {
      endpointPath: "/forms/submit/t",
      title: `<b>Bold</b>`,
      buttonText: "Send",
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>Bold</b>");
    expect(html).toContain("&lt;b&gt;Bold&lt;/b&gt;");
  });

  it("marks required fields and omits the description when empty", () => {
    const html = renderFormHtml(def, {
      endpointPath: "/forms/submit/t",
      title: "Hi",
      description: null,
      buttonText: "Send",
    });
    expect(html).toContain('name="name" placeholder="Your name" required');
    expect(html).not.toContain("<p>");
  });
});
