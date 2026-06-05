from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class MultipartUploadPart:
    part_number: int
    upload_url: str


@dataclass(frozen=True)
class MultipartUploadInit:
    upload_id: str
    part_size: int
    parts: list[MultipartUploadPart]


@dataclass(frozen=True)
class ObjectHead:
    byte_size: int
    mime_type: str | None = None


@dataclass(frozen=True)
class CompletedUploadPart:
    part_number: int
    etag: str


class BoardAssetStorage(Protocol):
    def create_presigned_put_url(
        self,
        *,
        storage_key: str,
        mime_type: str,
        expires_seconds: int,
    ) -> str: ...

    def create_multipart_upload(
        self,
        *,
        storage_key: str,
        mime_type: str,
        byte_size: int,
        part_size: int,
        expires_seconds: int,
    ) -> MultipartUploadInit: ...

    def complete_multipart_upload(
        self,
        *,
        storage_key: str,
        upload_id: str,
        parts: list[CompletedUploadPart],
    ) -> None: ...

    def head_object(self, *, storage_key: str) -> ObjectHead: ...

    def create_presigned_get_url(
        self,
        *,
        storage_key: str,
        expires_seconds: int,
    ) -> str: ...


class R2BoardAssetStorage:
    def __init__(
        self,
        *,
        endpoint_url: str,
        bucket: str,
        access_key_id: str,
        secret_access_key: str,
    ) -> None:
        import boto3

        self._bucket = bucket
        self._client = boto3.client(
            "s3",
            endpoint_url=endpoint_url,
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
        )

    def create_presigned_put_url(
        self,
        *,
        storage_key: str,
        mime_type: str,
        expires_seconds: int,
    ) -> str:
        return self._client.generate_presigned_url(
            "put_object",
            Params={
                "Bucket": self._bucket,
                "Key": storage_key,
                "ContentType": mime_type,
            },
            ExpiresIn=expires_seconds,
        )

    def create_multipart_upload(
        self,
        *,
        storage_key: str,
        mime_type: str,
        byte_size: int,
        part_size: int,
        expires_seconds: int,
    ) -> MultipartUploadInit:
        response = self._client.create_multipart_upload(
            Bucket=self._bucket,
            Key=storage_key,
            ContentType=mime_type,
        )
        upload_id = response["UploadId"]
        part_count = (byte_size + part_size - 1) // part_size
        parts = [
            MultipartUploadPart(
                part_number=part_number,
                upload_url=self._client.generate_presigned_url(
                    "upload_part",
                    Params={
                        "Bucket": self._bucket,
                        "Key": storage_key,
                        "UploadId": upload_id,
                        "PartNumber": part_number,
                    },
                    ExpiresIn=expires_seconds,
                ),
            )
            for part_number in range(1, part_count + 1)
        ]
        return MultipartUploadInit(upload_id=upload_id, part_size=part_size, parts=parts)

    def complete_multipart_upload(
        self,
        *,
        storage_key: str,
        upload_id: str,
        parts: list[CompletedUploadPart],
    ) -> None:
        self._client.complete_multipart_upload(
            Bucket=self._bucket,
            Key=storage_key,
            UploadId=upload_id,
            MultipartUpload={
                "Parts": [
                    {"PartNumber": part.part_number, "ETag": part.etag}
                    for part in sorted(parts, key=lambda part: part.part_number)
                ],
            },
        )

    def head_object(self, *, storage_key: str) -> ObjectHead:
        response = self._client.head_object(Bucket=self._bucket, Key=storage_key)
        return ObjectHead(
            byte_size=int(response["ContentLength"]),
            mime_type=response.get("ContentType"),
        )

    def create_presigned_get_url(
        self,
        *,
        storage_key: str,
        expires_seconds: int,
    ) -> str:
        return self._client.generate_presigned_url(
            "get_object",
            Params={"Bucket": self._bucket, "Key": storage_key},
            ExpiresIn=expires_seconds,
        )
