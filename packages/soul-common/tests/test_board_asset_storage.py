from urllib.parse import parse_qs, urlparse

from botocore.stub import Stubber

from soul_common.catalog.board_asset_storage import R2BoardAssetStorage


def _create_storage() -> R2BoardAssetStorage:
    return R2BoardAssetStorage(
        endpoint_url="https://example-account.r2.cloudflarestorage.com",
        bucket="soulstream-assets",
        access_key_id="test-access-key",
        secret_access_key="test-secret-key",
    )


def _assert_sigv4_presigned_url(url: str) -> None:
    query = parse_qs(urlparse(url).query)
    assert query["X-Amz-Algorithm"] == ["AWS4-HMAC-SHA256"]
    assert "X-Amz-Credential" in query
    assert "X-Amz-Date" in query
    assert "X-Amz-SignedHeaders" in query
    assert "X-Amz-Signature" in query
    assert "AWSAccessKeyId" not in query
    assert "Signature" not in query


def test_create_presigned_put_url_uses_sigv4_markers() -> None:
    url = _create_storage().create_presigned_put_url(
        storage_key="folders/f1/assets/a1/photo.png",
        mime_type="image/png",
        expires_seconds=3600,
    )

    _assert_sigv4_presigned_url(url)


def test_create_multipart_upload_part_urls_use_sigv4_markers() -> None:
    storage = _create_storage()
    storage_key = "folders/f1/assets/a1/clip.mp4"

    with Stubber(storage._client) as stubber:
        stubber.add_response(
            "create_multipart_upload",
            {"UploadId": "upload-1"},
            {
                "Bucket": "soulstream-assets",
                "Key": storage_key,
                "ContentType": "video/mp4",
            },
        )

        upload = storage.create_multipart_upload(
            storage_key=storage_key,
            mime_type="video/mp4",
            byte_size=6 * 1024 * 1024,
            part_size=5 * 1024 * 1024,
            expires_seconds=3600,
        )

    assert len(upload.parts) == 2
    for part in upload.parts:
        _assert_sigv4_presigned_url(part.upload_url)


def test_create_presigned_get_url_uses_sigv4_markers() -> None:
    url = _create_storage().create_presigned_get_url(
        storage_key="folders/f1/assets/a1/photo.png",
        expires_seconds=3600,
    )

    _assert_sigv4_presigned_url(url)
