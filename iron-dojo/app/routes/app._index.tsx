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
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(PRODUCTS_QUERY);
  const json = await response.json();

  const raw: Product[] = (
    json.data?.products?.edges ?? []
  ).map((edge: { node: Product }) => edge.node);

  const limit = PLAN_LIMITS[CURRENT_PLAN];

  const sorted = raw
    .map((p) => ({ ...p, scores: scoreProduct(p) }))
    .sort((a, b) => a.scores.listingQuality - b.scores.listingQuality);

  const visibleProducts = Number.isFinite(limit)
    ? sorted.slice(0, limit)
    : sorted;

  return {
    visibleProducts,
    totalCount: sorted.length,
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

export default function IronDojoDashboard() {
  const { visibleProducts, totalCount, limit } =
    useLoaderData<typeof loader>();
  const count = visibleProducts.length;

  return (
    <s-page heading="Iron Dojo">
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
          heading={`Opportunity Queue — lowest scoring products first (${count} ${count === 1 ? "product" : "products"})`}
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
          {totalCount > count ? (
            <s-paragraph>
              Showing {count} of {totalCount} products. Upgrade to unlock
              the full opportunity queue.
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
