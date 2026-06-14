import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

const PRODUCTS_QUERY = `#graphql
  query IronDojoProducts {
    products(first: 50) {
      edges {
        node {
          id
          title
          status
          totalInventory
          featuredImage {
            url
            altText
          }
          variants(first: 1) {
            edges {
              node {
                price
              }
            }
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
  featuredImage: { url: string; altText: string | null } | null;
  variants: { edges: { node: { price: string } }[] };
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(PRODUCTS_QUERY);
  const json = await response.json();

  const products: Product[] = (
    json.data?.products?.edges ?? []
  ).map((edge: { node: Product }) => edge.node);

  return { products };
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
  const { products } = useLoaderData<typeof loader>();
  const count = products.length;

  return (
    <s-page heading="Iron Dojo">
      {count === 0 ? (
        <s-section heading="Products">
          <s-heading>No products found</s-heading>
          <s-paragraph>
            This store has no products yet. Add products in your Shopify admin
            and they will appear here.
          </s-paragraph>
        </s-section>
      ) : (
        <s-section
          heading={`Products — Showing ${count} ${count === 1 ? "product" : "products"}`}
        >
          <s-table>
            <s-table-header-row>
              <s-table-header>Image</s-table-header>
              <s-table-header>Title</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Price</s-table-header>
              <s-table-header>Inventory</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {products.map((product) => {
                const price = product.variants.edges[0]?.node.price ?? "—";
                const inventory =
                  product.totalInventory !== null
                    ? String(product.totalInventory)
                    : "—";
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
                      <s-link href={`/app/products/${product.id.split("/").pop()}`}>
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
                      <s-text>{inventory}</s-text>
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
