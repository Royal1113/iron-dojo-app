import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  scoreProduct,
  scoreTone,
  revOpportunityTone,
  PLAN_LIMITS,
  CURRENT_PLAN,
} from "../lib/scoring";
import prisma from "../db.server";

const COMPLETION_THRESHOLD = 80;

const PRODUCTS_QUERY = `#graphql
  query IronDojoProducts {
    products(first: 50) {
      edges {
        node {
          id
          title
          status
          totalInventory
          productType
          vendor
          descriptionHtml
          tags
          featuredImage {
            url
            altText
          }
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

const PRODUCTS_BY_IDS_QUERY = `#graphql
  query IronDojoProductsByIds($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        status
        totalInventory
        productType
        vendor
        descriptionHtml
        tags
        featuredImage {
          url
          altText
        }
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
`;

type Product = {
  id: string;
  title: string;
  status: string;
  totalInventory: number | null;
  productType: string;
  vendor: string;
  descriptionHtml: string;
  tags: string[];
  featuredImage: { url: string; altText: string | null } | null;
  images: { edges: { node: { url: string } }[] };
  variants: { edges: { node: { price: string } }[] };
  seo: { title: string | null; description: string | null } | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const plan = CURRENT_PLAN;
  const limit = PLAN_LIMITS[plan];

  let visibleProducts: (Product & {
    scores: ReturnType<typeof scoreProduct>;
    isComplete: boolean;
  })[];

  const existingBatch = await prisma.productBatch.findUnique({
    where: { shop_plan: { shop, plan } },
  });

  if (!existingBatch) {
    const response = await admin.graphql(PRODUCTS_QUERY);
    const json = await response.json();
    const raw: Product[] = (json.data?.products?.edges ?? []).map(
      (edge: { node: Product }) => edge.node,
    );

    const scored = raw
      .map((p) => ({ ...p, scores: scoreProduct(p) }))
      .sort((a, b) => a.scores.listingQuality - b.scores.listingQuality);

    const sliced = Number.isFinite(limit)
      ? scored.slice(0, limit as number)
      : scored;

    await prisma.productBatch.create({
      data: {
        shop,
        plan,
        productIds: JSON.stringify(sliced.map((p) => p.id)),
      },
    });

    visibleProducts = sliced.map((p) => ({
      ...p,
      isComplete: p.scores.listingQuality >= COMPLETION_THRESHOLD,
    }));
  } else {
    const assignedIds: string[] = JSON.parse(existingBatch.productIds);

    const response = await admin.graphql(PRODUCTS_BY_IDS_QUERY, {
      variables: { ids: assignedIds },
    });
    const json = await response.json();

    const nodes = (json.data?.nodes ?? []) as (Product | null)[];
    const fetched = nodes.filter(
      (p): p is Product =>
        p !== null && typeof (p as Product).id === "string",
    );

    visibleProducts = fetched.map((p) => {
      const scores = scoreProduct(p);
      return {
        ...p,
        scores,
        isComplete: scores.listingQuality >= COMPLETION_THRESHOLD,
      };
    });
  }

  const batchComplete =
    visibleProducts.length > 0 &&
    visibleProducts.every((p) => p.isComplete);

  return {
    visibleProducts,
    batchComplete,
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

export default function IronDojoDashboard() {
  const { visibleProducts, batchComplete, plan, limit } =
    useLoaderData<typeof loader>();
  const count = visibleProducts.length;
  const hasLimit = Number.isFinite(limit);

  // ── M20: Store-level analytics (all derived from existing visibleProducts) ──

  const avgListingQuality =
    count === 0
      ? 0
      : Math.round(
          visibleProducts.reduce((sum, p) => sum + p.scores.listingQuality, 0) /
            count,
        );

  const avgRevenueOpportunity =
    count === 0
      ? 0
      : Math.round(
          visibleProducts.reduce(
            (sum, p) => sum + p.scores.revenueOpportunity,
            0,
          ) / count,
        );

  const activeCount = visibleProducts.filter(
    (p) => p.status === "ACTIVE",
  ).length;
  const draftCount = visibleProducts.filter(
    (p) => p.status === "DRAFT",
  ).length;
  const archivedCount = visibleProducts.filter(
    (p) => p.status === "ARCHIVED",
  ).length;
  const criticalCount = visibleProducts.filter(
    (p) => p.scores.listingQuality < 50,
  ).length;

  const issueMap = new Map<string, number>();
  for (const p of visibleProducts) {
    for (const check of p.scores.checks) {
      if (!check.passed) {
        issueMap.set(check.label, (issueMap.get(check.label) ?? 0) + 1);
      }
    }
  }
  const topIssues = [...issueMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const priorityProducts = [...visibleProducts]
    .sort((a, b) => a.scores.listingQuality - b.scores.listingQuality)
    .slice(0, 5);

  const batchCompleteMessage =
    plan === "PRO"
      ? "Your entire catalog is fully optimized."
      : plan === "STARTER"
      ? "Upgrade to Pro to unlock all products."
      : "Upgrade to Starter to unlock 25 products.";

  return (
    <s-page heading="Iron Dojo">
      {batchComplete ? (
        <s-banner tone="success">
          <s-paragraph>
            Current batch complete — all {count}{" "}
            {count === 1 ? "product" : "products"} in your {plan} batch{" "}
            {count === 1 ? "has" : "have"} been improved!
          </s-paragraph>
          <s-paragraph>{batchCompleteMessage}</s-paragraph>
        </s-banner>
      ) : null}

      {/* ── M20: Store Health ── */}
      {count > 0 ? (
        <s-section heading="Store Health">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base">
              <s-stack direction="block" gap="small-200">
                <s-text>Store Health Score</s-text>
                <s-badge tone={scoreTone(avgListingQuality)}>
                  {avgListingQuality}/100
                </s-badge>
              </s-stack>
              <s-stack direction="block" gap="small-200">
                <s-text>Revenue Opportunity Average</s-text>
                <s-badge tone={revOpportunityTone(avgRevenueOpportunity)}>
                  {avgRevenueOpportunity}/100
                </s-badge>
              </s-stack>
            </s-stack>
            <s-stack direction="inline" gap="base">
              <s-stack direction="block" gap="small-200">
                <s-text>Total assigned</s-text>
                <s-text>{count}</s-text>
              </s-stack>
              <s-stack direction="block" gap="small-200">
                <s-text>Active</s-text>
                <s-badge tone="success">{activeCount}</s-badge>
              </s-stack>
              {draftCount > 0 ? (
                <s-stack direction="block" gap="small-200">
                  <s-text>Draft</s-text>
                  <s-badge tone="warning">{draftCount}</s-badge>
                </s-stack>
              ) : null}
              {archivedCount > 0 ? (
                <s-stack direction="block" gap="small-200">
                  <s-text>Archived</s-text>
                  <s-badge tone="neutral">{archivedCount}</s-badge>
                </s-stack>
              ) : null}
              {criticalCount > 0 ? (
                <s-stack direction="block" gap="small-200">
                  <s-text>Critical issues</s-text>
                  <s-badge tone="critical">{criticalCount}</s-badge>
                </s-stack>
              ) : null}
            </s-stack>
            {plan !== "PRO" ? (
              <s-paragraph>
                You are viewing your assigned {plan} batch. Upgrade to unlock
                more products.
              </s-paragraph>
            ) : null}
          </s-stack>
        </s-section>
      ) : null}

      {/* ── M20: Top Issues ── */}
      {topIssues.length > 0 ? (
        <s-section heading="Top Issues">
          <s-table>
            <s-table-header-row>
              <s-table-header>Issue</s-table-header>
              <s-table-header>Products affected</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {topIssues.map(([label, affectedCount]) => (
                <s-table-row key={label}>
                  <s-table-cell>
                    <s-text>{label}</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge
                      tone={
                        affectedCount === count
                          ? "critical"
                          : affectedCount >= Math.ceil(count / 2)
                          ? "warning"
                          : "neutral"
                      }
                    >
                      {affectedCount}/{count}
                    </s-badge>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      ) : null}

      {/* ── M20: Fix These First ── */}
      {priorityProducts.length > 0 && !batchComplete ? (
        <s-section heading="Fix These First">
          <s-table>
            <s-table-header-row>
              <s-table-header>Product</s-table-header>
              <s-table-header>Listing Quality</s-table-header>
              <s-table-header>Top Issue</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {priorityProducts.map((p) => {
                const topIssueLabel =
                  p.scores.checks.find((c) => !c.passed)?.label ?? "None";
                return (
                  <s-table-row key={p.id}>
                    <s-table-cell>
                      <s-link
                        href={`/app/products/${p.id.split("/").pop()}`}
                      >
                        {p.title}
                      </s-link>
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge tone={scoreTone(p.scores.listingQuality)}>
                        {p.scores.listingQuality}/100
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text>{topIssueLabel}</s-text>
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        </s-section>
      ) : null}

      {count === 0 ? (
        <s-section heading="Opportunity Queue">
          <s-heading>No products found</s-heading>
          <s-paragraph>
            This store has no products yet. Add products in your Shopify admin
            and they will appear here.
          </s-paragraph>
        </s-section>
      ) : (
        <s-section
          heading={`Opportunity Queue — your assigned ${plan} batch (${count} ${count === 1 ? "product" : "products"})`}
        >
          <s-table>
            <s-table-header-row>
              <s-table-header>Image</s-table-header>
              <s-table-header>Title</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Price</s-table-header>
              <s-table-header>Listing Quality</s-table-header>
              <s-table-header>Revenue Opportunity</s-table-header>
              <s-table-header>Issues</s-table-header>
              <s-table-header>Top Issue</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {visibleProducts.map((product) => {
                const price = product.variants.edges[0]?.node.price ?? "—";
                const issueCount = product.scores.checks.filter(
                  (c) => !c.passed,
                ).length;
                const topIssue =
                  product.scores.checks.find((c) => !c.passed)?.label ??
                  "None";
                return (
                  <s-table-row key={product.id}>
                    <s-table-cell>
                      {product.featuredImage ? (
                        <s-thumbnail
                          src={product.featuredImage.url}
                          alt={
                            product.featuredImage.altText ?? product.title
                          }
                          size="small"
                        />
                      ) : (
                        <s-thumbnail
                          src=""
                          alt={product.title}
                          size="small"
                        />
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      <s-link
                        href={`/app/products/${product.id.split("/").pop()}`}
                      >
                        {product.title}
                      </s-link>
                      {product.isComplete ? (
                        <s-badge tone="success">Improved</s-badge>
                      ) : null}
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge tone={statusTone(product.status)}>
                        {capitalize(product.status)}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text>${price}</s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge
                        tone={scoreTone(product.scores.listingQuality)}
                      >
                        {product.scores.listingQuality}/100
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge
                        tone={revOpportunityTone(
                          product.scores.revenueOpportunity,
                        )}
                      >
                        {product.scores.revenueOpportunity}/100
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text>{issueCount}</s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text>{topIssue}</s-text>
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
          {hasLimit && !batchComplete ? (
            <s-paragraph>
              Showing your {count} assigned products for the {plan} plan.
              Upgrade to unlock more products.
            </s-paragraph>
          ) : null}
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
