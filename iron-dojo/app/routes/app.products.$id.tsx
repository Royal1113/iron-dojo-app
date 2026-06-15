import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useEffect, useState } from "react";
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
import prisma from "../db.server";

const COMPLETION_THRESHOLD = 80;

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

const SHOP_QUERY = `#graphql
  query IronDojoShop {
    shop {
      name
    }
  }
`;

const PRODUCT_UPDATE_MUTATION = `#graphql
  mutation IronDojoProductUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product {
        id
        title
        tags
        descriptionHtml
        seo {
          title
          description
        }
      }
      userErrors {
        field
        message
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

function mergeAndNormalizeTags(
  existingTags: string[],
  aiTags: string[],
): string[] {
  const normalize = (t: string): string =>
    t
      .toLowerCase()
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

  const seen = new Set<string>();
  const result: string[] = [];

  for (const tag of existingTags) {
    const norm = normalize(tag);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      result.push(tag);
    }
  }

  const slotsRemaining = Math.max(0, 10 - result.length);
  let added = 0;
  for (const tag of aiTags) {
    if (added >= slotsRemaining) break;
    const norm = normalize(tag);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      result.push(tag);
      added++;
    }
  }

  return result;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const intent = formData.get("intent");

  // --- Apply Recommendations ---
  if (intent === "applyRecommendations") {
    const productId = formData.get("productId");
    const selectedFieldsRaw = formData.get("selectedFields");
    const valuesRaw = formData.get("valuesJson");
    const existingTagsRaw = formData.get("existingTagsJson");

    if (
      typeof productId !== "string" ||
      !productId ||
      typeof selectedFieldsRaw !== "string" ||
      typeof valuesRaw !== "string" ||
      typeof existingTagsRaw !== "string"
    ) {
      return { applyError: "Missing data for update." };
    }

    let selectedFields: string[];
    let aiValues: AiSuggestionResult;
    let existingTags: string[];
    try {
      selectedFields = JSON.parse(selectedFieldsRaw) as string[];
      aiValues = JSON.parse(valuesRaw) as AiSuggestionResult;
      existingTags = JSON.parse(existingTagsRaw) as string[];
    } catch {
      return { applyError: "Invalid update data." };
    }

    if (!selectedFields.length) {
      return { applyError: "No fields selected." };
    }

    try {
      const input: Record<string, unknown> = { id: productId };

      if (selectedFields.includes("title")) input.title = aiValues.title;
      if (selectedFields.includes("description"))
        input.descriptionHtml = aiValues.description;

      if (
        selectedFields.includes("seoTitle") ||
        selectedFields.includes("metaDescription")
      ) {
        const seo: Record<string, string> = {};
        if (selectedFields.includes("seoTitle")) seo.title = aiValues.seoTitle;
        if (selectedFields.includes("metaDescription"))
          seo.description = aiValues.metaDescription;
        input.seo = seo;
      }

      if (selectedFields.includes("tags")) {
        input.tags = mergeAndNormalizeTags(existingTags, aiValues.tags);
      }

      const response = await admin.graphql(PRODUCT_UPDATE_MUTATION, {
        variables: { input },
      });
      const json = await response.json();
      const userErrors: { field: string[]; message: string }[] =
        json.data?.productUpdate?.userErrors ?? [];

      if (userErrors.length > 0) {
        return { applyError: userErrors.map((e) => e.message).join(" ") };
      }

      console.log("[IronDojo] productUpdate", {
        id: productId,
        updatedFields: selectedFields,
        resultId: json.data?.productUpdate?.product?.id,
      });

      return { applySuccess: true as const };
    } catch (err) {
      console.error("[IronDojo] productUpdate error:", err);
      const e = err as { message?: string; body?: { errors?: { graphQLErrors?: { message: string }[] } } };
      const gqlMessages = e.body?.errors?.graphQLErrors?.map((g) => g.message).join(" ");
      const applyError = gqlMessages || e.message || "Failed to update product. Please try again.";
      return { applyError };
    }
  }

  // --- Generate AI Recommendations ---
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
      `Shop Name: ${promptData.shopName}`,
      `Product Context: ${promptData.productContext}`,
      `Product Title: ${promptData.title}`,
      `Vendor (internal field, may be generic or test data): ${promptData.vendor}`,
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
      system: [
        "You are a Shopify product listing optimizer. Return only valid JSON — no markdown fences, no explanation, no extra keys.",
        "",
        "Branding rules:",
        "- Do not invent or assume a brand name.",
        "- The Vendor field is an internal Shopify field and may contain generic, operational, or test values (e.g. 'Snowboard Vendor', 'IronDojo testing', 'Default Vendor').",
        "- If the vendor looks like a real, recognisable brand, you may reference it naturally.",
        "- If the vendor looks generic, internal, or test-like, do NOT use it in customer-facing copy. Use neutral product language instead (e.g. 'this board', 'the product', 'this item').",
        "- You may use the Shop Name as light attribution only if it reads naturally as a real business name. Never include the shop name in tags.",
        "",
        "Product context rules:",
        "If Product Context is \"gift_card\":",
        "- Treat this as a gift card, not as the underlying merchandise.",
        "- Do not describe it as physical equipment, gear, or a performance product.",
        "- Focus on gifting, recipient choice, redemption, flexibility, convenience, and available denominations.",
        "- Titles must preserve the words 'Gift Card' clearly.",
        "- Tags must include gift-card and gifting-related terms, not equipment or sport-specific tags.",
        "- Avoid claims about performance, materials, durability, fit, or technical specifications.",
        "",
        "If Product Context is \"standard_product\":",
        "- Optimize as a normal Shopify product listing.",
        "- Focus on product benefits, use cases, buyer intent, SEO clarity, and conversion.",
        "- Do not invent specs, materials, measurements, warranties, or claims not present in the product data.",
      ].join("\n"),
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
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const rawId = `gid://shopify/Product/${params.id ?? ""}`;
  const plan = CURRENT_PLAN;
  const limit = PLAN_LIMITS[plan];

  const batch = await prisma.productBatch.findUnique({
    where: { shop_plan: { shop, plan } },
  });

  const assignedIds: string[] = batch ? JSON.parse(batch.productIds) : [];

  if (!assignedIds.includes(rawId)) {
    return {
      locked: true as const,
      plan,
      limit,
      product: null,
      scores: null,
      isComplete: false,
    };
  }

  const [detailResponse, shopResponse] = await Promise.all([
    admin.graphql(PRODUCT_DETAIL_QUERY, { variables: { id: rawId } }),
    admin.graphql(SHOP_QUERY),
  ]);
  const [detailJson, shopJson] = await Promise.all([
    detailResponse.json(),
    shopResponse.json(),
  ]);
  const product: ProductDetail | null = detailJson.data?.product ?? null;
  const shopName: string = shopJson.data?.shop?.name ?? "";

  if (!product) {
    throw new Response("Product not found", { status: 404 });
  }

  const scores = scoreProduct(product);
  const isComplete = scores.listingQuality >= COMPLETION_THRESHOLD;

  return {
    locked: false as const,
    product,
    scores,
    isComplete,
    shopName,
    plan,
    limit,
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


type ProductContext = "gift_card" | "standard_product";
// Future branches (not implemented): "apparel" | "digital" | "service" | "dropship" | "subscription"

function classifyProductContext(product: {
  title: string;
  productType: string;
  tags: string[];
}): ProductContext {
  const title = product.title.toLowerCase();
  const type = product.productType.toLowerCase().replace(/[\s_-]/g, "");
  const tags = product.tags.map((t) => t.toLowerCase().replace(/[\s_]/g, "-"));

  if (
    ["giftcard", "giftcards"].includes(type) ||
    title.includes("gift card") ||
    tags.some((t) =>
      ["gift-card", "giftcard", "gift-cards", "giftcards"].includes(t),
    )
  ) {
    return "gift_card";
  }

  // TODO: future branches — apparel, digital, service, dropship, subscription

  return "standard_product";
}

interface AiPromptData {
  title: string;
  vendor: string;
  shopName: string;
  productContext: ProductContext;
  productType: string;
  tags: string[];
  description: string;
  seoTitle: string;
  seoDescription: string;
}

function buildAiPrompt(
  product: {
    title: string;
    vendor: string;
    productType: string;
    tags: string[];
    descriptionHtml: string;
    seo?: { title?: string | null; description?: string | null } | null;
  },
  shopName: string,
): AiPromptData {
  return {
    title: product.title,
    vendor: product.vendor,
    shopName,
    productContext: classifyProductContext(product),
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
        <s-section heading="Not in Your Batch">
          <s-banner tone="warning">
            <s-paragraph>
              This product is not in your assigned {data.plan} batch.
            </s-paragraph>
            <s-paragraph>
              Your {data.plan} plan assigns the {data.limit} lowest-scoring
              products at first analysis. Visit the dashboard to view your
              assigned products, or upgrade to unlock more.
            </s-paragraph>
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  const { product, scores, isComplete } = data;

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

  const applyFetcher = useFetcher<{ applySuccess?: boolean; applyError?: string }>();
  const revalidator = useRevalidator();

  const [aiSelected, setAiSelected] = useState<Set<string>>(new Set());
  type AiStep = "idle" | "confirming";
  const [aiStep, setAiStep] = useState<AiStep>("idle");

  useEffect(() => {
    if (applyFetcher.data?.applySuccess) {
      setAiSelected(new Set());
      setAiStep("idle");
      revalidator.revalidate();
    }
  }, [applyFetcher.data]);

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
      {isComplete ? (
        <s-banner tone="success">
          <s-paragraph>
            This product has been improved — listing quality is{" "}
            {scores.listingQuality}/100.
          </s-paragraph>
        </s-banner>
      ) : null}
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
                { promptJson: JSON.stringify(buildAiPrompt(product, data.shopName ?? "")) },
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
                      selected fields will be changed. This cannot be undone
                      automatically.
                      {aiSelected.has("tags")
                        ? " Selecting Tags will merge AI tags with your existing tag list."
                        : ""}
                    </s-paragraph>
                  </s-banner>
                  <button
                    type="button"
                    disabled={applyFetcher.state === "submitting"}
                    onClick={() => {
                      applyFetcher.submit(
                        {
                          intent: "applyRecommendations",
                          productId: product.id,
                          selectedFields: JSON.stringify([...aiSelected]),
                          valuesJson: JSON.stringify(aiResult),
                          existingTagsJson: JSON.stringify(product.tags),
                        },
                        { method: "post" },
                      );
                    }}
                  >
                    {applyFetcher.state === "submitting"
                      ? "Applying…"
                      : "Apply to Shopify"}
                  </button>
                </s-stack>
              )}

              {applyFetcher.data?.applyError && (
                <s-banner tone="critical">
                  <s-paragraph>{applyFetcher.data.applyError}</s-paragraph>
                </s-banner>
              )}

              {applyFetcher.data?.applySuccess && (
                <s-banner tone="success">
                  <s-paragraph>Product updated successfully.</s-paragraph>
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
