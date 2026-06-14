import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  scoreProduct,
  scoreTone,
  revOpportunityTone,
  revOpportunityLabel,
  stripHtml,
  PLAN_LIMITS,
  CURRENT_PLAN,
} from "../lib/scoring";

const PRODUCT_DETAIL_QUERY = `#graphql
  query IronDojoProductDetail($id: ID!) {
    product(id: $id) {
      id
      title
      status
      vendor
      productType
      totalInventory
      descriptionHtml
      tags
      featuredImage {
        url
        altText
      }
      images(first: 20) {
        edges {
          node {
            url
            altText
          }
        }
      }
      variants(first: 100) {
        edges {
          node {
            id
            title
            price
            inventoryQuantity
          }
        }
      }
      seo {
        title
        description
      }
    }
  }
`;

const PRODUCTS_GATE_QUERY = `#graphql
  query IronDojoProductsGate {
    products(first: 50) {
      edges {
        node {
          id
          status
          totalInventory
          productType
          vendor
          title
          descriptionHtml
          tags
          images(first: 3) {
            edges {
              node {
                url
              }
            }
          }
          variants(first: 1) {
            edges {
              node {
                price
              }
            }
          }
          seo {
            title
            description
          }
        }
      }
    }
  }
`;

type ProductImage = { url: string; altText: string | null };
type Variant = {
  id: string;
  title: string;
  price: string;
  inventoryQuantity: number | null;
};

type ProductDetail = {
  id: string;
  title: string;
  status: string;
  vendor: string;
  productType: string;
  totalInventory: number | null;
  descriptionHtml: string;
  tags: string[];
  featuredImage: ProductImage | null;
  images: { edges: { node: ProductImage }[] };
  variants: { edges: { node: Variant }[] };
  seo: { title: string | null; description: string | null } | null;
};

type GateProduct = {
  id: string;
  status: string;
  totalInventory: number | null;
  productType: string;
  vendor: string;
  title: string;
  descriptionHtml: string;
  tags: string[];
  images: { edges: unknown[] };
  variants: { edges: { node: { price: string } }[] };
  seo: { title: string | null; description: string | null } | null;
};


const FIX_LABELS: Record<string, string> = {
  "Status is not Active": "Set product status to Active",
  "Inventory is zero or missing": "Add inventory",
  "Product type is missing": "Add a product type",
  "Vendor is missing": "Add a vendor name",
  "Title is shorter than 20 characters": "Lengthen the product title",
  "Description is missing or under 100 characters": "Improve description",
  "Fewer than 5 tags": "Add more tags",
  "Fewer than 3 images": "Add more product images",
  "No variant price found": "Set a variant price",
  "SEO title is missing": "Add SEO title",
  "SEO meta description is missing": "Add SEO meta description",
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);

  const formData = await request.formData();
  const promptJson = formData.get("promptJson");

  if (typeof promptJson !== "string" || !promptJson) {
    return { error: "Missing prompt data." };
  }

  let promptData: AiPromptData;
  try {
    promptData = JSON.parse(promptJson) as AiPromptData;
  } catch {
    return { error: "Invalid prompt data." };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { error: "AI not configured." };
  }

  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });

    const promptText = [
      `Title: ${promptData.title}`,
      `Vendor: ${promptData.vendor}`,
      `Product Type: ${promptData.productType}`,
      `Current Tags: ${promptData.tags.join(", ") || "(none)"}`,
      `Current Description: ${promptData.description || "(none)"}`,
      `Current SEO Title: ${promptData.seoTitle || "(none)"}`,
      `Current SEO Description: ${promptData.seoDescription || "(none)"}`,
      "",
      "Return a JSON object with exactly these keys:",
      '{ "title": "<compelling title, max 80 chars>", "seoTitle": "<SEO title, max 60 chars>", "metaDescription": "<meta description, max 160 chars>", "tags": ["<kebab-case tag>"], "description": "<2-3 sentence product description>" }',
    ].join("\n");

    const message = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 8192,
      system:
        "You are a Shopify product listing optimizer. Return only valid JSON — no markdown fences, no explanation, no extra keys.",
      messages: [{ role: "user", content: promptText }],
    });

    const rawText =
      message.content[0]?.type === "text" ? message.content[0].text : "";
    const cleaned = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    const parsed: unknown = JSON.parse(cleaned);

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).title !== "string" ||
      typeof (parsed as Record<string, unknown>).seoTitle !== "string" ||
      typeof (parsed as Record<string, unknown>).metaDescription !== "string" ||
      !Array.isArray((parsed as Record<string, unknown>).tags) ||
      typeof (parsed as Record<string, unknown>).description !== "string"
    ) {
      return { error: "AI response was incomplete. Please try again." };
    }

    const p = parsed as Record<string, unknown>;

    const rawTags = (p.tags as unknown[]).filter(
      (t): t is string => typeof t === "string",
    );
    const seen = new Set<string>();
    const cleanedTags = rawTags
      .map((t) =>
        t
          .toLowerCase()
          .trim()
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9-]/g, "")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, ""),
      )
      .filter((t) => {
        if (!t || seen.has(t)) return false;
        seen.add(t);
        return true;
      })
      .slice(0, 10);

    const title = p.title as string;
    const seoTitle = p.seoTitle as string;
    const metaDescription = p.metaDescription as string;
    const description = p.description as string;

    if (
      !title || title.length > 80 ||
      !seoTitle || seoTitle.length > 60 ||
      !metaDescription || metaDescription.length > 160 ||
      !description || description.length < 100 || description.length > 1000
    ) {
      return { error: "AI recommendation rejected by quality gate." };
    }

    const result: AiSuggestionResult = {
      title,
      seoTitle,
      metaDescription,
      tags: cleanedTags,
      description,
    };

    return { result };
  } catch (err) {
    console.error("Anthropic AI error:", err);
    return { error: "AI service unavailable. Please try again." };
  }
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const rawId = `gid://shopify/Product/${params.id ?? ""}`;

  const [detailResponse, gateResponse] = await Promise.all([
    admin.graphql(PRODUCT_DETAIL_QUERY, { variables: { id: rawId } }),
    admin.graphql(PRODUCTS_GATE_QUERY),
  ]);
  const [detailJson, gateJson] = await Promise.all([
    detailResponse.json(),
    gateResponse.json(),
  ]);

  const product: ProductDetail | null = detailJson.data?.product ?? null;

  if (!product) {
    throw new Response("Product not found", { status: 404 });
  }

  const limit = PLAN_LIMITS[CURRENT_PLAN];
  const allGate: GateProduct[] = (
    gateJson.data?.products?.edges ?? []
  ).map((e: { node: GateProduct }) => e.node);

  const visibleIds = new Set(
    allGate
      .map((p) => ({ id: p.id, lq: scoreProduct(p).listingQuality }))
      .sort((a, b) => a.lq - b.lq)
      .slice(0, Number.isFinite(limit) ? limit : undefined)
      .map((p) => p.id),
  );

  if (!visibleIds.has(product.id)) {
    return {
      locked: true as const,
      limit,
      plan: CURRENT_PLAN,
      product: null,
      scores: null,
    };
  }

  const scores = scoreProduct(product);
  return {
    locked: false as const,
    product,
    scores,
    limit,
    plan: CURRENT_PLAN,
  };
};

function statusTone(
  status: string,
): "success" | "caution" | "neutral" | "critical" {
  switch (status) {
    case "ACTIVE":
      return "success";
    case "DRAFT":
      return "caution";
    case "ARCHIVED":
      return "neutral";
    default:
      return "neutral";
  }
}

function capitalize(str: string) {
  return str.charAt(0) + str.slice(1).toLowerCase();
}


interface AiPromptData {
  title: string;
  vendor: string;
  productType: string;
  tags: string[];
  description: string;
  seoTitle: string;
  seoDescription: string;
}

function buildAiPrompt(product: {
  title: string;
  vendor: string;
  productType: string;
  tags: string[];
  descriptionHtml: string;
  seo?: { title?: string | null; description?: string | null } | null;
}): AiPromptData {
  return {
    title: product.title,
    vendor: product.vendor,
    productType: product.productType,
    tags: product.tags,
    description: stripHtml(product.descriptionHtml),
    seoTitle: product.seo?.title ?? "",
    seoDescription: product.seo?.description ?? "",
  };
}

export interface AiSuggestionResult {
  title: string;
  seoTitle: string;
  metaDescription: string;
  tags: string[];
  description: string;
}

export default function ProductDetail() {
  const data = useLoaderData<typeof loader>();

  if (data.locked) {
    return (
      <s-page heading="Iron Dojo">
        <s-link slot="breadcrumb-actions" href="/app">
          Products
        </s-link>
        <s-section heading="Upgrade Required">
          <s-banner tone="warning">
            <s-paragraph>
              This product is outside your current plan limit.
            </s-paragraph>
            <s-paragraph>
              Your {data.plan} plan shows the {data.limit} lowest-scoring
              products. Upgrade to STARTER to see 25 products, or PRO for
              unlimited access.
            </s-paragraph>
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  const { product, scores } = data;

  const variants = product.variants.edges.map((e) => e.node);
  const images = product.images.edges.map((e) => e.node);
  const hasSeo = product.seo?.title || product.seo?.description;
  const failedChecks = scores.checks.filter((c) => !c.passed);
  const fixPlan = [...failedChecks].sort((a, b) => b.weight - a.weight);
  const pointsRecoverable = fixPlan.reduce((sum, c) => sum + c.weight, 0);
  const potentialScore = Math.min(
    scores.listingQuality + pointsRecoverable,
    100,
  );
  const aiFetcher = useFetcher<{ result?: AiSuggestionResult; error?: string }>();
  const aiResult = aiFetcher.data?.result ?? null;
  const aiError = aiFetcher.data?.error ?? null;
  const aiLoading = aiFetcher.state === "submitting";

  const [aiSelected, setAiSelected] = useState<Set<string>>(new Set());
  type AiStep = "idle" | "confirming" | "done";
  const [aiStep, setAiStep] = useState<AiStep>("idle");

  const toggleAiRec = (key: string) => {
    setAiSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setAiStep("idle");
  };

  return (
    <s-page heading={product.title}>
      <s-link slot="breadcrumb-actions" href="/app">Products</s-link>
      {/* Primary info */}
      <s-section heading="Details">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            <s-text>Status</s-text>
            <s-badge tone={statusTone(product.status)}>
              {capitalize(product.status)}
            </s-badge>
          </s-stack>

          {product.vendor ? (
            <s-stack direction="inline" gap="base">
              <s-text>Vendor</s-text>
              <s-text>{product.vendor}</s-text>
            </s-stack>
          ) : null}

          {product.productType ? (
            <s-stack direction="inline" gap="base">
              <s-text>Product type</s-text>
              <s-text>{product.productType}</s-text>
            </s-stack>
          ) : null}

          <s-stack direction="inline" gap="base">
            <s-text>Total inventory</s-text>
            <s-text>
              {product.totalInventory !== null
                ? String(product.totalInventory)
                : "—"}
            </s-text>
          </s-stack>

          {product.tags.length > 0 ? (
            <s-stack direction="block" gap="small-200">
              <s-text>Tags</s-text>
              <s-stack direction="inline" gap="small-200">
                {product.tags.map((tag) => (
                  <s-badge key={tag} tone="neutral">
                    {tag}
                  </s-badge>
                ))}
              </s-stack>
            </s-stack>
          ) : null}
        </s-stack>
      </s-section>

      {/* Description */}
      {product.descriptionHtml ? (
        <s-section heading="Description">
          <div
            dangerouslySetInnerHTML={{ __html: product.descriptionHtml }}
            style={{ fontSize: "14px", lineHeight: 1.6 }}
          />
        </s-section>
      ) : null}

      {/* Variants */}
      <s-section heading={`Variants (${variants.length})`}>
        {variants.length === 0 ? (
          <s-paragraph>No variants found.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Variant</s-table-header>
              <s-table-header>Price</s-table-header>
              <s-table-header>Inventory</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {variants.map((variant) => (
                <s-table-row key={variant.id}>
                  <s-table-cell>
                    <s-text>{variant.title}</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text>${variant.price}</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text>
                      {variant.inventoryQuantity !== null
                        ? String(variant.inventoryQuantity)
                        : "—"}
                    </s-text>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      {/* Images */}
      {images.length > 0 ? (
        <s-section heading={`Images (${images.length})`}>
          <s-stack direction="inline" gap="base">
            {images.map((img, i) => (
              <s-thumbnail
                key={img.url}
                src={img.url}
                alt={img.altText ?? `Product image ${i + 1}`}
                size="large"
              />
            ))}
          </s-stack>
        </s-section>
      ) : null}

      {/* SEO */}
      {hasSeo ? (
        <s-section heading="SEO">
          <s-stack direction="block" gap="base">
            {product.seo?.title ? (
              <s-stack direction="block" gap="small-200">
                <s-text>SEO title</s-text>
                <s-text>{product.seo.title}</s-text>
              </s-stack>
            ) : null}
            {product.seo?.description ? (
              <s-stack direction="block" gap="small-200">
                <s-text>Meta description</s-text>
                <s-text>{product.seo.description}</s-text>
              </s-stack>
            ) : null}
          </s-stack>
        </s-section>
      ) : null}

      {/* Fix Plan */}
      {fixPlan.length > 0 ? (
        <s-section heading="Fix Plan">
          <s-stack direction="block" gap="base">
            <s-stack direction="block" gap="small-200">
              <s-stack direction="inline" gap="base">
                <s-text>Current Score:</s-text>
                <s-text>{scores.listingQuality}/100</s-text>
              </s-stack>
              <s-stack direction="inline" gap="base">
                <s-text>Potential Score:</s-text>
                <s-text>{potentialScore}/100</s-text>
              </s-stack>
              <s-stack direction="inline" gap="base">
                <s-text>Improvement:</s-text>
                <s-text>+{pointsRecoverable} points</s-text>
              </s-stack>
            </s-stack>
            <s-stack direction="block" gap="small-200">
              {fixPlan.map((check) => (
                <s-stack key={check.label} direction="inline" gap="base">
                  <s-badge tone="success">+{check.weight}</s-badge>
                  <s-text>{FIX_LABELS[check.label] ?? check.label}</s-text>
                </s-stack>
              ))}
            </s-stack>
          </s-stack>
        </s-section>
      ) : (
        <s-section heading="Fix Plan">
          <s-text>All checks passed — no fixes needed.</s-text>
        </s-section>
      )}


      {/* AI Recommendations */}
      <s-section heading="AI Recommendations">
        <s-stack direction="block" gap="base">
          <button
            type="button"
            disabled={aiLoading}
            onClick={() => {
              setAiSelected(new Set());
              setAiStep("idle");
              aiFetcher.submit(
                { promptJson: JSON.stringify(buildAiPrompt(product)) },
                { method: "post" },
              );
            }}
          >
            {aiLoading ? "Generating…" : "Generate AI Recommendations"}
          </button>

          {aiError && (
            <s-banner tone="critical">
              <s-paragraph>{aiError}</s-paragraph>
            </s-banner>
          )}

          {aiResult && (
            <s-stack direction="block" gap="base">
              <s-banner tone="info">
                <s-paragraph>
                  AI recommendations based on your product data. Review and
                  approve any changes before applying them.
                </s-paragraph>
              </s-banner>

              {(
                [
                  {
                    key: "title",
                    label: "Title",
                    current: product.title || "(none)",
                    suggested: aiResult.title,
                  },
                  {
                    key: "seoTitle",
                    label: "SEO Title",
                    current: product.seo?.title || "(none)",
                    suggested: aiResult.seoTitle,
                  },
                  {
                    key: "metaDescription",
                    label: "Meta Description",
                    current: product.seo?.description || "(none)",
                    suggested: aiResult.metaDescription,
                  },
                  {
                    key: "tags",
                    label: "Tags",
                    current: product.tags.join(", ") || "(none)",
                    suggested: aiResult.tags.join(", "),
                  },
                  {
                    key: "description",
                    label: "Product Description",
                    current: stripHtml(product.descriptionHtml) || "(none)",
                    suggested: aiResult.description,
                  },
                ] as { key: string; label: string; current: string; suggested: string }[]
              ).map(({ key, label, current, suggested }) => (
                <s-stack key={key} direction="block" gap="small-200">
                  <s-stack direction="inline" gap="base">
                    <input
                      type="checkbox"
                      id={`ai-rec-${key}`}
                      checked={aiSelected.has(key)}
                      onChange={() => toggleAiRec(key)}
                    />
                    <label htmlFor={`ai-rec-${key}`}>{label}</label>
                  </s-stack>
                  <s-stack direction="inline" gap="base">
                    <s-text>Current:</s-text>
                    <s-text>{current}</s-text>
                  </s-stack>
                  <s-stack direction="inline" gap="base">
                    <s-text>AI Recommended:</s-text>
                    <s-text>{suggested}</s-text>
                  </s-stack>
                </s-stack>
              ))}

              <button
                type="button"
                disabled={aiSelected.size === 0}
                onClick={() => setAiStep("confirming")}
              >
                Apply Selected Recommendations
              </button>

              {aiStep === "confirming" && (
                <s-stack direction="block" gap="base">
                  <s-banner tone="warning">
                    <s-paragraph>
                      You are about to update this product in Shopify. Only
                      selected fields will be changed. This simulation does not
                      modify Shopify yet.
                    </s-paragraph>
                  </s-banner>
                  <button type="button" onClick={() => setAiStep("done")}>
                    Confirm Simulation
                  </button>
                </s-stack>
              )}

              {aiStep === "done" && (
                <s-banner tone="success">
                  <s-paragraph>
                    Simulation complete. Selected AI recommendations are ready
                    to apply in a future write-enabled version.
                  </s-paragraph>
                </s-banner>
              )}
            </s-stack>
          )}
        </s-stack>
      </s-section>

      {/* Scores in aside */}
      <s-section slot="aside" heading="Iron Dojo Scores">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            <s-text>Product Health</s-text>
            <s-badge tone={scoreTone(scores.productHealth)}>
              {scores.productHealth}/100
            </s-badge>
          </s-stack>
          <s-stack direction="inline" gap="base">
            <s-text>Listing Quality</s-text>
            <s-badge tone={scoreTone(scores.listingQuality)}>
              {scores.listingQuality}/100
            </s-badge>
          </s-stack>
          <s-stack direction="inline" gap="base">
            <s-text>Revenue Opportunity</s-text>
            <s-badge tone={revOpportunityTone(scores.revenueOpportunity)}>
              {scores.revenueOpportunity}/100
            </s-badge>
          </s-stack>
          <s-text>{revOpportunityLabel(scores.revenueOpportunity)}</s-text>
        </s-stack>
        {failedChecks.length > 0 ? (
          <s-stack direction="block" gap="small-200">
            <s-text>Recommended fixes</s-text>
            {failedChecks.map((check) => (
              <s-text key={check.label}>✗ {check.label}</s-text>
            ))}
          </s-stack>
        ) : (
          <s-text>✓ All checks passed</s-text>
        )}
      </s-section>

      {/* Featured image in aside */}
      {product.featuredImage ? (
        <s-section slot="aside" heading="Featured image">
          <s-thumbnail
            src={product.featuredImage.url}
            alt={product.featuredImage.altText ?? product.title}
            size="large-100"
          />
        </s-section>
      ) : null}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
