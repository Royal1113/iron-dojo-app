import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

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

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const rawId = decodeURIComponent(params.id ?? "");

  const response = await admin.graphql(PRODUCT_DETAIL_QUERY, {
    variables: { id: rawId },
  });
  const json = await response.json();
  const product: ProductDetail | null = json.data?.product ?? null;

  if (!product) {
    throw new Response("Product not found", { status: 404 });
  }

  return { product };
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

export default function ProductDetail() {
  const { product } = useLoaderData<typeof loader>();

  const variants = product.variants.edges.map((e) => e.node);
  const images = product.images.edges.map((e) => e.node);
  const hasSeo = product.seo?.title || product.seo?.description;

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
