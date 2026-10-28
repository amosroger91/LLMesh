import {nodeProfile} from '../shared/node-profile.js';
export function profileEditor(container,initial,save){
  let profile=nodeProfile(initial),timer;const field=(labelText,element)=>{const label=document.createElement('label');label.textContent=labelText;label.append(element);container.append(label);return element;};
  const preview=document.createElement('img');preview.alt='Your node profile photo';preview.width=64;preview.height=64;preview.className='node-profile-preview';container.append(preview);
  const name=field('NODE NAME',document.createElement('input'));name.maxLength=40;name.value=profile.name;
  const bio=field('BIO · PUBLIC · UP TO 160 CHARACTERS',document.createElement('textarea'));bio.maxLength=160;bio.rows=2;bio.value=profile.bio;
  const ring=field('PROFILE RING COLOR',document.createElement('input'));ring.type='color';ring.value=profile.ringColor;
  const photo=field('PROFILE PHOTO · RESIZED ON THIS DEVICE',document.createElement('input'));photo.type='file';photo.accept='image/jpeg,image/png,image/webp';
  const remove=document.createElement('button');remove.className='secondary';remove.textContent='Remove photo';container.append(remove);
  const note=document.createElement('p');note.className='micro hint';note.setAttribute('role','status');note.textContent='Changes save automatically. This profile is visible to other mesh participants.';container.append(note);
  const draw=()=>{preview.hidden=!profile.avatar;if(profile.avatar)preview.src=profile.avatar;else preview.removeAttribute('src');preview.style.borderColor=ring.value;};draw();
  const persist=async()=>{try{profile=nodeProfile({...profile,name:name.value,bio:bio.value,ringColor:ring.value});await save(profile);draw();note.textContent='Saved · visible to other mesh participants';}catch(error){note.textContent=error.message;}};
  for(const input of [name,bio,ring])input.oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>{void persist();},400);};
  remove.onclick=()=>{profile.avatar='';void persist();};
  photo.onchange=async()=>{try{const file=photo.files?.[0];if(!file)return;if(file.size>10000000)throw new Error('Choose an image smaller than 10 MB');const url=URL.createObjectURL(file),image=new Image();
    try{image.src=url;await image.decode();const canvas=document.createElement('canvas');canvas.width=canvas.height=64;const side=Math.min(image.naturalWidth,image.naturalHeight);canvas.getContext('2d').drawImage(image,(image.naturalWidth-side)/2,(image.naturalHeight-side)/2,side,side,0,0,64,64);profile.avatar=canvas.toDataURL('image/jpeg',0.65);await persist();}finally{URL.revokeObjectURL(url);photo.value='';}
  }catch(error){note.textContent=error.message;}};
}
