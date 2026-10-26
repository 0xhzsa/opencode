import { Resource } from "sst/resource"
import { newsletterEmail } from "~/lib/newsletter"

const listId = "8b9bb82c-9d5f-11f0-975f-0df6fd1e4945"

export async function POST(event: { request: Request }) {
  const contentType = event.request.headers.get("content-type") ?? ""
  if (!contentType.includes("multipart/form-data") && !contentType.includes("application/x-www-form-urlencoded")) {
    return Response.json({ error: "Email address is required" }, { status: 400 })
  }

  const form = await event.request.formData()
  const emailAddress = newsletterEmail(form.get("email"))
  if (!emailAddress) return Response.json({ error: "A valid email address is required" }, { status: 400 })
  // Outside production, accept sign-ups without writing to the production list.
  if (import.meta.env.DEV || Resource.App.stage !== "production") return Response.json({ success: true })

  const response = await fetch(`https://api.emailoctopus.com/lists/${listId}/contacts`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${Resource.EMAILOCTOPUS_API_KEY.value}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email_address: emailAddress,
    }),
  })
  if (!response.ok) return Response.json({ error: "Failed to subscribe" }, { status: 502 })
  return Response.json({ success: true })
}
