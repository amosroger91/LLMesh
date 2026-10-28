export function nodeProfile(value={},fallbackName='Web node'){
  const name=String(value.name??fallbackName).trim()||fallbackName,bio=String(value.bio??'').trim(),avatar=String(value.avatar??''),ringColor=String(value.ringColor??'#00aeef');
  if(name.length>40||bio.length>160||avatar.length>8192||!/^#[a-f0-9]{6}$/i.test(ringColor))throw new Error('Use a name up to 40 characters, bio up to 160, and a valid ring color');
  if(avatar&&!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar))throw new Error('Use a small JPEG, PNG or WebP profile photo');
  return {name,bio,avatar,ringColor};
}
