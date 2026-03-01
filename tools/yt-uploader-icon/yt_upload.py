#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]


def get_creds(client_secret: Path, token_path: Path) -> Credentials:
    creds = None
    if token_path.exists():
        creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(str(client_secret), SCOPES)
            creds = flow.run_local_server(port=0)
        token_path.write_text(creds.to_json(), encoding="utf-8")
    return creds


def set_thumbnail(youtube, video_id: str, thumb_path: Path) -> None:
    # YouTube accepts JPG/PNG; let ffmpeg/your pipeline produce a JPG for reliability.
    mime = "image/png" if thumb_path.suffix.lower() == ".png" else "image/jpeg"
    media = MediaFileUpload(str(thumb_path), mimetype=mime, resumable=False)
    youtube.thumbnails().set(videoId=video_id, media_body=media).execute()
    print("Thumbnail set.")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("video", help="Path to video file")
    ap.add_argument("--title", required=True)
    ap.add_argument("--description", default="")
    ap.add_argument("--privacy", choices=["private", "unlisted", "public"], default="unlisted")
    ap.add_argument("--tags", default="", help="Comma-separated tags")
    ap.add_argument("--category", default="22", help="YouTube categoryId (default 22=People & Blogs)")
    ap.add_argument("--thumbnail", default=None, help="Path to thumbnail JPG/PNG")
    ap.add_argument("--client-secret", default="client_secret_864598374760-8r139n0soqe4il6j8n8p6v3ce69f4tle.apps.googleusercontent.com.json")
    ap.add_argument("--token", default="yt_token.json")
    args = ap.parse_args()

    video_path = Path(args.video).expanduser().resolve()
    if not video_path.exists():
        raise SystemExit(f"Not found: {video_path}")

    client_secret = Path(args.client_secret).expanduser().resolve()
    if not client_secret.exists():
        raise SystemExit(f"Missing OAuth client secret JSON: {client_secret}")

    thumb_path = Path(args.thumbnail).expanduser().resolve() if args.thumbnail else None
    if thumb_path and not thumb_path.exists():
        raise SystemExit(f"Thumbnail not found: {thumb_path}")

    token_path = Path(args.token).expanduser().resolve()

    creds = get_creds(client_secret, token_path)
    youtube = build("youtube", "v3", credentials=creds)

    body = {
        "snippet": {
            "title": args.title,
            "description": args.description,
            "categoryId": args.category,
            "tags": [t.strip() for t in args.tags.split(",") if t.strip()],
        },
        "status": {"privacyStatus": args.privacy},
    }

    media = MediaFileUpload(str(video_path), chunksize=-1, resumable=True)
    req = youtube.videos().insert(part="snippet,status", body=body, media_body=media)

    response = None
    while response is None:
        status, response = req.next_chunk()
        if status:
            print(f"Upload: {int(status.progress() * 100)}%")

    video_id = response.get("id")
    print(f"Uploaded video ID: {video_id}")

    if thumb_path:
        set_thumbnail(youtube, video_id, thumb_path)


if __name__ == "__main__":
    main()